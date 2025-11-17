#!/usr/bin/env python3
import sys
import json
import re
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


def parse_time(t: str) -> float:
    m = SRT_TIME_RE.match(t.strip())
    if not m:
        return 0.0
    h, m_, s, ms = map(int, m.groups())
    return timedelta(hours=h, minutes=m_, seconds=s, milliseconds=ms).total_seconds()


def load_srt(path: str) -> List[Cue]:
    cues = []
    with open(path, encoding="utf-8", errors="ignore") as f:
        block = []
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                if len(block) >= 2:
                    # block[0] = index, block[1] = time line
                    times = re.findall(r"(\d+:\d+:\d+,\d+)", block[1])
                    if len(times) == 2:
                        start = parse_time(times[0])
                        end = parse_time(times[1])
                        text = " ".join(block[2:]).strip()
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
                text = " ".join(block[2:]).strip()
                if text:
                    cues.append(Cue(len(cues), start, end, text))
    return cues


def compute_embeddings(model, texts: List[str]) -> np.ndarray:
    return model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)


def build_similarity_matrix(eng_cues: List[Cue], fin_cues: List[Cue],
                            eng_vecs: np.ndarray, fin_vecs: np.ndarray) -> np.ndarray:
    # cosine similarity of embeddings
    emb_sim = st_util.cos_sim(eng_vecs, fin_vecs).cpu().numpy()  # shape (N, M)

    # fuzzy text similarity (scaled 0–1)
    N, M = emb_sim.shape
    fuzz_sim = np.zeros_like(emb_sim, dtype=np.float32)
    for i in range(N):
        e = eng_cues[i].text.lower()
        for j in range(M):
            f = fin_cues[j].text.lower()
            score = fuzz.token_sort_ratio(e, f) / 100.0
            fuzz_sim[i, j] = score

    # hybrid similarity
    sim = 0.7 * emb_sim + 0.3 * fuzz_sim
    # clamp to [0,1]
    sim = np.clip(sim, 0.0, 1.0)
    return sim


def align_sequences(sim: np.ndarray, gap_penalty: float = 0.15) -> List[Tuple[int, int, float]]:
    """
    Dynamic programming alignment.
    Returns list of (i, j, score) pairs.
    """
    N, M = sim.shape
    dp = np.zeros((N + 1, M + 1), dtype=np.float32)
    ptr = np.zeros((N + 1, M + 1), dtype=np.int8)  # 1 = diag, 2 = up (skip eng), 3 = left (skip fin)

    # initialize with gap penalties
    for i in range(1, N + 1):
        dp[i, 0] = dp[i - 1, 0] - gap_penalty
        ptr[i, 0] = 2
    for j in range(1, M + 1):
        dp[0, j] = dp[0, j - 1] - gap_penalty
        ptr[0, j] = 3

    # fill
    for i in range(1, N + 1):
        for j in range(1, M + 1):
            match = dp[i - 1, j - 1] + sim[i - 1, j - 1]
            skip_i = dp[i - 1, j] - gap_penalty
            skip_j = dp[i, j - 1] - gap_penalty
            best = match
            pi = 1
            if skip_i > best:
                best = skip_i
                pi = 2
            if skip_j > best:
                best = skip_j
                pi = 3
            dp[i, j] = best
            ptr[i, j] = pi

    # backtrack
    i, j = N, M
    pairs: List[Tuple[int, int, float]] = []
    while i > 0 or j > 0:
        if ptr[i, j] == 1:
            pairs.append((i - 1, j - 1, float(sim[i - 1, j - 1])))
            i -= 1
            j -= 1
        elif ptr[i, j] == 2:
            i -= 1
        elif ptr[i, j] == 3:
            j -= 1
        else:
            break

    pairs.reverse()
    return pairs


def extract_anchors(eng_cues: List[Cue], fin_cues: List[Cue],
                    aligned: List[Tuple[int, int, float]],
                    min_score: float = 0.55) -> List[dict]:
    anchors = []
    for i, j, score in aligned:
        if score < min_score:
            continue
        ce = eng_cues[i]
        cf = fin_cues[j]
        offset = cf.start - ce.start
        anchors.append({
            "eng_index": ce.index,
            "fin_index": cf.index,
            "eng_start": round(ce.start, 3),
            "fin_start": round(cf.start, 3),
            "offset": round(offset, 3),
            "score": round(score, 3),
        })
    return anchors


def analyze_pair(eng_path: str, fin_path: str) -> dict:
    eng_cues = load_srt(eng_path)
    fin_cues = load_srt(fin_path)

    if not eng_cues or not fin_cues:
        return {"error": "one or both subtitles empty"}

    texts_eng = [c.text for c in eng_cues]
    texts_fin = [c.text for c in fin_cues]

    model = SentenceTransformer("sentence-transformers/LaBSE")
    eng_vecs = compute_embeddings(model, texts_eng)
    fin_vecs = compute_embeddings(model, texts_fin)

    sim = build_similarity_matrix(eng_cues, fin_cues, eng_vecs, fin_vecs)
    aligned = align_sequences(sim)
    anchors = extract_anchors(eng_cues, fin_cues, aligned)

    if not anchors:
        return {
            "error": "no good anchors",
            "eng_count": len(eng_cues),
            "fin_count": len(fin_cues),
        }

    offsets = [a["offset"] for a in anchors]
    avg_off = sum(offsets) / len(offsets)
    min_off, max_off = min(offsets), max(offsets)

    # simple “drift curve”: sample every ~N/40 anchors
    step = max(1, len(anchors) // 40)
    drift = [
        {"t": a["eng_start"], "offset": a["offset"]}
        for idx, a in enumerate(anchors)
        if idx % step == 0
    ]

    return {
        "eng_path": eng_path,
        "fin_path": fin_path,
        "eng_count": len(eng_cues),
        "fin_count": len(fin_cues),
        "anchor_count": len(anchors),
        "avg_offset_sec": round(avg_off, 3),
        "min_offset_sec": round(min_off, 3),
        "max_offset_sec": round(max_off, 3),
        "drift_span_sec": round(max_off - min_off, 3),
        "anchors": anchors,
        "drift": drift,
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: align.py /path/to/reference.srt /path/to/target.srt", file=sys.stderr)
        sys.exit(1)

    eng_path = sys.argv[1]
    fin_path = sys.argv[2]
    result = analyze_pair(eng_path, fin_path)
    print(json.dumps(result))
