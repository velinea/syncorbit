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

import json
import re
import statistics
import sys
from dataclasses import dataclass
from datetime import timedelta
from typing import List, Tuple

import numpy as np
from rapidfuzz import fuzz
from sentence_transformers import SentenceTransformer
from sentence_transformers import util as st_util

# Limit PyTorch threads for performance consistency
import torch

torch.set_num_threads(2)
torch.set_num_interop_threads(2)


# ---------------- CONFIG TUNABLES ---------------- #

# Similarity threshold for raw matches
MIN_SIM = 0.40  # was ~0.35; you can push up/down a bit

# Max ratio between longer/shorter text lengths
MAX_LEN_RATIO = 1.5  # you saw 3 → good results

# Max ratio between longer/shorter cue durations
MAX_DUR_RATIO = 1.5

# Minimum characters for a line to be considered as an anchor candidate
MIN_CHARS = 10

# Residual threshold bounds for regression-based cleanup
RESID_MIN = 0.8  # don't be tighter than this
RESID_MAX = 1.8  # don't be looser than this
RESID_MAD_FACTOR = 3.0  # scale median absolute deviation


SRT_TIME_RE = re.compile(r"(\d+):(\d+):(\d+),(\d+)")


@dataclass
class Cue:
    index: int
    start: float  # seconds
    end: float  # seconds
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
                        text_lines = [
                            re.sub(r"<.*?>", "", t).strip() for t in block[2:]
                        ]
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


def align_sequences(
    sim: np.ndarray, gap_penalty: float = 0.15
) -> List[Tuple[int, int, float]]:
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

FILLER_SET = {
    "yes",
    "yeah",
    "yep",
    "no",
    "ok",
    "okay",
    "oh",
    "ah",
    "mm",
    "hmm",
    "hey",
    "hi",
    "bye",
    # you can expand this with Finnish fillers too if needed
}


def build_raw_anchors(
    ref_cues: List[Cue],
    tgt_cues: List[Cue],
    aligned: List[Tuple[int, int, float]],
) -> List[dict]:
    """
    Turn aligned index pairs into raw anchor candidates
    with basic content checks.
    """
    raw = []

    for i, j, score in aligned:
        r = ref_cues[i]
        t = tgt_cues[j]

        rt = r.text.strip()
        tt = t.text.strip()

        # too short -> skip
        if len(rt) < MIN_CHARS or len(tt) < MIN_CHARS:
            continue

        # single word or filler
        if rt.lower() in FILLER_SET or tt.lower() in FILLER_SET:
            continue
        if len(rt.split()) == 1 or len(tt.split()) == 1:
            continue

        # length ratio
        len_ratio = max(len(rt), len(tt)) / max(1, min(len(rt), len(tt)))
        if len_ratio > MAX_LEN_RATIO:
            continue

        # duration ratio
        rdur = max(0.001, r.end - r.start)
        tdur = max(0.001, t.end - t.start)
        dur_ratio = max(rdur, tdur) / min(rdur, tdur)
        if dur_ratio > MAX_DUR_RATIO:
            continue

        # similarity threshold
        if score < MIN_SIM:
            continue

        raw.append(
            {
                "ref_index": r.index,
                "tgt_index": t.index,
                "ref_t": r.start,
                "tgt_t": t.start,
                "delta": t.start - r.start,
                "score": score,
                "len_ratio": len_ratio,
                "dur_ratio": dur_ratio,
            }
        )

    # keep in time order
    raw.sort(key=lambda a: a["ref_t"])
    return raw


def clean_anchors_regression(anchors: List[dict]) -> List[dict]:
    """
    Robust regression-based cleanup:
    - fit delta ~ a + b * ref_t
    - drop outliers with large residuals
    """
    if len(anchors) < 10:
        return anchors  # not enough data for regression

    t = np.array([a["ref_t"] for a in anchors], dtype=np.float32)
    d = np.array([a["delta"] for a in anchors], dtype=np.float32)

    # center time to improve numeric stability
    t0 = t.mean()
    tc = t - t0

    # linear fit: d ~ k*tc + b
    k, b = np.polyfit(tc, d, 1)
    fit = k * tc + b
    resid = d - fit

    mad = np.median(np.abs(resid)) or 0.001
    thresh = RESID_MAD_FACTOR * mad
    thresh = max(RESID_MIN, min(RESID_MAX, thresh))

    cleaned = []
    for a, r in zip(anchors, resid):
        if abs(r) <= thresh:
            cleaned.append(a)

    # if we threw away almost everything, fall back
    if len(cleaned) < max(10, len(anchors) // 10):
        return anchors

    return cleaned


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
        print(
            "Usage: align.py /path/to/reference.srt /path/to/target.srt",
            file=sys.stderr,
        )
        sys.exit(1)

    ref_path = sys.argv[1]
    tgt_path = sys.argv[2]

    ref_cues = load_srt(ref_path)
    tgt_cues = load_srt(tgt_path)

    if not ref_cues or not tgt_cues:
        print(
            json.dumps(
                {
                    "error": "empty_subtitles",
                    "ref_path": ref_path,
                    "target_path": tgt_path,
                    "ref_count": len(ref_cues),
                    "target_count": len(tgt_cues),
                }
            )
        )
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

    raw_anchors = build_raw_anchors(ref_cues, tgt_cues, aligned)

    # IMPORTANT CHANGE:
    # We no longer run clean_anchors_regression() here.
    # We let compute_metrics() see all raw anchors,
    # then we do robust outlier filtering after.
    metrics = compute_metrics(raw_anchors)

    # ----------------------------------------------
    # Robust drift analysis (MAD-based)
    # ----------------------------------------------
    offsets = metrics["offsets"]  # list of anchor dicts

    deltas = [o.get("delta") or o.get("offset") or 0.0 for o in offsets]

    if deltas:
        median_delta = statistics.median(deltas)
        mad = statistics.median([abs(d - median_delta) for d in deltas]) or 1e-6

        clean = []
        outliers = []
        for o in offsets:
            d = o.get("delta") or o.get("offset") or 0.0
            if abs(d - median_delta) <= 2.5 * mad:
                clean.append(o)
            else:
                outliers.append(o)

        robust_span = 4.0 * mad

        # robust versions of metrics
        anchor_count_clean = len(clean)
        avg_offset_clean = median_delta  # robust "average"
    else:
        median_delta = 0.0
        mad = 1e-6
        clean = []
        outliers = []
        robust_span = 0.0
        anchor_count_clean = 0
        avg_offset_clean = 0.0

    # Decision now based on ROBUST metrics
    decision = decide_quality(
        anchor_count_clean,
        avg_offset_clean,
        robust_span,
    )

    out = {
        "ref_path": ref_path,
        "target_path": tgt_path,
        "ref_count": len(ref_cues),
        "target_count": len(tgt_cues),
        # ROBUST versions become the main ones:
        "anchor_count": anchor_count_clean,
        "avg_offset_sec": avg_offset_clean,
        "min_offset_sec": metrics["min_offset_sec"],  # still from raw
        "max_offset_sec": metrics["max_offset_sec"],  # still from raw
        "drift_span_sec": robust_span,
        # Keep raw for debugging / advanced use if you want later:
        "raw_anchor_count": metrics["anchor_count"],
        "raw_drift_span_sec": metrics["drift_span_sec"],
        # offsets:
        "offsets": offsets,  # raw anchors
        "clean_offsets": clean,  # robust-cleaned anchors
        "outlier_offsets": outliers,  # spikes we threw out
        "median_offset_sec": median_delta,
        "mad_offset_sec": mad,
        "robust_drift_span_sec": robust_span,
        "drift_curve": metrics["drift_curve"],
        "decision": decision,
    }

    print(json.dumps(out))


if __name__ == "__main__":
    main()
