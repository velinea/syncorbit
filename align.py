#!/usr/bin/env python3
"""
align.py

Robust subtitle alignment engine for SyncOrbit.

Usage:
    python3 align.py /path/to/reference.srt /path/to/target.srt

Outputs JSON to stdout with fields:
    {
      "ref_path": "...",
      "target_path": "...",
      "ref_count": int,
      "target_count": int,
      "anchor_count": int,
      "avg_offset_sec": float,
      "drift_span_sec": float,
      "min_offset_sec": float,
      "max_offset_sec": float,
      "offsets": [
        { "ref_t": float, "target_t": float, "delta": float, "score": float },
        ...
      ],
      "drift_curve": [
        { "ref_t": float, "delta": float },
        ...
      ],
      "decision": "synced" | "needs_adjustment" | "whisper_required"
    }
"""

import sys
import re
import json
from dataclasses import dataclass
from datetime import timedelta
from typing import List, Tuple

import numpy as np
from rapidfuzz import fuzz
from sentence_transformers import SentenceTransformer, util as st_util


SRT_TIME_RE = re.compile(r"(\d+):(\d+):(\d+),(\d+)")


@dataclass
class Cue:
    index: int
    start: float  # seconds
    end: float    # seconds
    text: str


# ---------- SRT parsing ----------

def parse_time(t: str) -> float:
    m = SRT_TIME_RE.match(t.strip())
    if not m:
        return 0.0
    h, m_, s, ms = map(int, m.groups())
    return timedelta(hours=h, minutes=m_, seconds=s, milliseconds=ms).total_seconds()


def load_srt(path: str) -> List[Cue]:
    cues: List[Cue] = []
    block: List[str] = []

    with open(path, encoding="utf-8", errors="ignore") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip():
                if len(block) >= 2:
                    times = re.findall(r"(\d+:\d+:\d+,\d+)", block[1])
                    if len(times) == 2:
                        start = parse_time(times[0])
                        end = parse_time(times[1])
                        # Join all text lines, strip tags like <i> etc.
                        text_lines = [re.sub(r"<.*?>", "", t).strip() for t in block[2:]]
                        text = " ".join(l for l in text_lines if l)
                        if text:
                            cues.append(Cue(len(cues), start, end, text))
                block = []
            else:
                block.append(line.strip())

        # flush last block
        if len(block) >= 2:
            times = re.findall(r"(\d+:\d+:\d+,\d+)", block[1])
            if len(times) == 2:
                start = parse_time(times[0])
                end = parse_time(times[1])
                text_lines = [re.sub(r"<.*?>", "", t).strip() for t in block[2:]]
                text = " ".join(l for l in text_lines if l)
                if text:
                    cues.append(Cue(len(cues), start, end, text))

    return cues


# ---------- Similarity + alignment ----------

def compute_embeddings(model, texts: List[str]) -> np.ndarray:
    # Normalize embeddings to unit length (cosine similarity)
    return model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)


def build_similarity_matrix(
    ref_cues: List[Cue],
    tgt_cues: List[Cue],
    ref_vecs: np.ndarray,
    tgt_vecs: np.ndarray,
) -> np.ndarray:
    """
    Hybrid similarity: cosine(embeddings) + fuzzy(token).
    """
    # cosine similarity (SentenceTransformer)
    emb_sim = st_util.cos_sim(ref_vecs, tgt_vecs).cpu().numpy()  # shape (N, M)

    N, M = emb_sim.shape
    fuzz_sim = np.zeros_like(emb_sim, dtype=np.float32)

    for i in range(N):
        rt = ref_cues[i].text.lower()
        for j in range(M):
            tt = tgt_cues[j].text.lower()
            # token_set_ratio works well for reordered segments
            fuzz_sim[i, j] = fuzz.token_set_ratio(rt, tt) / 100.0

    # Hybrid weighting
    sim = 0.7 * emb_sim + 0.3 * fuzz_sim
    sim = np.clip(sim, 0.0, 1.0)
    return sim


def align_sequences(sim: np.ndarray, gap_penalty: float = 0.15) -> List[Tuple[int, int, float]]:
    """
    Dynamic programming global alignment (Needleman–Wunsch style).
    Returns list of (ref_index, tgt_index, similarity).
    """
    N, M = sim.shape
    dp = np.zeros((N + 1, M + 1), dtype=np.float32)
    ptr = np.zeros((N + 1, M + 1), dtype=np.int8)  # 1=diag, 2=up, 3=left

    # initialize with gaps
    for i in range(1, N + 1):
        dp[i, 0] = dp[i - 1, 0] - gap_penalty
        ptr[i, 0] = 2
    for j in range(1, M + 1):
        dp[0, j] = dp[0, j - 1] - gap_penalty
        ptr[0, j] = 3

    # fill DP
    for i in range(1, N + 1):
        for j in range(1, M + 1):
            match = dp[i - 1, j - 1] + sim[i - 1, j - 1]
            skip_i = dp[i - 1, j] - gap_penalty
            skip_j = dp[i, j - 1] - gap_penalty

            best = match
            way = 1
            if skip_i > best:
                best, way = skip_i, 2
            if skip_j > best:
                best, way = skip_j, 3

            dp[i, j] = best
            ptr[i, j] = way

    # backtrack
    i, j = N, M
    pairs: List[Tuple[int, int, float]] = []
    while i > 0 or j > 0:
        move = ptr[i, j]
        if move == 1:
            pairs.append((i - 1, j - 1, float(sim[i - 1, j - 1])))
            i -= 1
            j -= 1
        elif move == 2:
            i -= 1
        elif move == 3:
            j -= 1
        else:
            break

    pairs.reverse()
    return pairs


# ---------- Anchor filtering & metrics ----------

def filter_anchors(
    ref_cues: List[Cue],
    tgt_cues: List[Cue],
    aligned: List[Tuple[int, int, float]],
    min_score: float = 0.60,
) -> List[dict]:
    """
    From raw aligned pairs, produce a clean list of robust anchors:
    - min similarity score
    - reject huge text-length mismatches
    - keep best match per target index
    - rolling median filter on offsets
    """
    raw = []

    # 1) basic filtering
    for i, j, score in aligned:
        if score < min_score:
            continue

        r = ref_cues[i]
        t = tgt_cues[j]
        # length ratio filter: reject crazy mismatches (like 1 word vs 2 lines of speech)
        len_r = max(len(r.text), len(t.text)) / (1 + min(len(r.text), len(t.text)))
        if len_r > 4.0:
            continue

        raw.append({
            "ref_index": r.index,
            "tgt_index": t.index,
            "ref_t": r.start,
            "tgt_t": t.start,
            "delta": t.start - r.start,
            "score": score,
            "len_ratio": len_r,
        })

    if not raw:
        return []

    # 2) keep best per target index (handles merged/split cues)
    best_by_tgt = {}
    for a in raw:
        j = a["tgt_index"]
        if j not in best_by_tgt or a["score"] > best_by_tgt[j]["score"]:
            best_by_tgt[j] = a

    anchors = list(best_by_tgt.values())
    anchors.sort(key=lambda x: x["ref_t"])

    # 3) rolling median-based outlier removal
    if len(anchors) >= 7:
        deltas = np.array([a["delta"] for a in anchors], dtype=np.float32)
        # simple centered window median using convolution on a copy
        window = 7
        pad = window // 2
        padded = np.pad(deltas, pad_width=pad, mode="edge")
        med = np.zeros_like(deltas)
        for i in range(len(deltas)):
            med[i] = np.median(padded[i:i + window])

        cleaned = []
        for a, m in zip(anchors, med):
            if abs(a["delta"] - m) <= 1.2:  # 1.2s tolerance vs local median
                cleaned.append(a)
        anchors = cleaned

    return anchors


def compute_metrics(anchors: List[dict]) -> dict:
    if not anchors:
        return {
            "anchor_count": 0,
            "avg_offset_sec": 0.0,
            "min_offset_sec": 0.0,
            "max_offset_sec": 0.0,
            "drift_span_sec": 0.0,
            "offsets": [],
            "drift_curve": [],
        }

    deltas = [a["delta"] for a in anchors]
    avg_off = float(sum(deltas) / len(deltas))
    min_off = float(min(deltas))
    max_off = float(max(deltas))

    # offsets for graph (full list)
    offsets = [
        {
            "ref_t": float(a["ref_t"]),
            "target_t": float(a["tgt_t"]),
            "delta": float(a["delta"]),
            "score": float(a["score"]),
        }
        for a in anchors
    ]

    # drift curve: sample at most ~40 points for plotting
    step = max(1, len(anchors) // 40)
    drift_curve = [
        {"ref_t": float(a["ref_t"]), "delta": float(a["delta"])}
        for idx, a in enumerate(anchors)
        if idx % step == 0
    ]

    return {
        "anchor_count": len(anchors),
        "avg_offset_sec": round(avg_off, 3),
        "min_offset_sec": round(min_off, 3),
        "max_offset_sec": round(max_off, 3),
        "drift_span_sec": round(max_off - min_off, 3),
        "offsets": offsets,
        "drift_curve": drift_curve,
    }


def decide_quality(anchor_count: int, avg_offset: float, drift_span: float) -> str:
    """
    Decision logic for SyncOrbit:
      - 'synced': good anchors, low drift, small offset
      - 'whisper_required': few anchors or large drift/offset
      - 'needs_adjustment': somewhere in between
    """
    # few matches -> alignment unreliable
    if anchor_count < 10:
        return "whisper_required"

    if drift_span > 3.5:
        return "whisper_required"

    if abs(avg_offset) > 4.0:
        return "whisper_required"

    if anchor_count >= 20 and drift_span <= 2.0 and abs(avg_offset) <= 1.0:
        return "synced"

    return "needs_adjustment"


# ---------- Main ----------

def main():
    if len(sys.argv) != 3:
        print("Usage: align.py /path/to/reference.srt /path/to/target.srt", file=sys.stderr)
        sys.exit(1)

    ref_path = sys.argv[1]
    tgt_path = sys.argv[2]

    ref_cues = load_srt(ref_path)
    tgt_cues = load_srt(tgt_path)

    if not ref_cues or not tgt_cues:
        print(json.dumps({
            "error": "empty_subtitles",
            "ref_path": ref_path,
            "target_path": tgt_path,
            "ref_count": len(ref_cues),
            "target_count": len(tgt_cues),
        }))
        return

    # Model choice: multilingual, good balance
    model_name = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    model = SentenceTransformer(model_name)

    ref_texts = [c.text for c in ref_cues]
    tgt_texts = [c.text for c in tgt_cues]

    ref_vecs = compute_embeddings(model, ref_texts)
    tgt_vecs = compute_embeddings(model, tgt_texts)

    sim = build_similarity_matrix(ref_cues, tgt_cues, ref_vecs, tgt_vecs)
    aligned = align_sequences(sim)
    anchors = filter_anchors(ref_cues, tgt_cues, aligned)

    metrics = compute_metrics(anchors)

    decision = decide_quality(
        metrics["anchor_count"],
        metrics["avg_offset_sec"],
        metrics["drift_span_sec"],
    )

    out = {
        "ref_path": ref_path,
        "target_path": tgt_path,
        "ref_count": len(ref_cues),
        "target_count": len(tgt_cues),
        "anchor_count": metrics["anchor_count"],
        "avg_offset_sec": metrics["avg_offset_sec"],
        "min_offset_sec": metrics["min_offset_sec"],
        "max_offset_sec": metrics["max_offset_sec"],
        "drift_span_sec": metrics["drift_span_sec"],
        "offsets": metrics["offsets"],
        "drift_curve": metrics["drift_curve"],
        "decision": decision,
    }

    print(json.dumps(out))


if __name__ == "__main__":
    main()
