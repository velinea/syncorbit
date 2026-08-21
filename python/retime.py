#!/usr/bin/env python3
"""
retime.py

Re-time a legacy target subtitle (e.g. Finnish) onto the cue structure of an
in-sync reference subtitle (e.g. English), keeping the target's text but
adopting the reference's timecodes — the modern streaming style where both
language tracks share the same timecode values.

Output cues are sorted by start time. Cues that need manual attention are
marked inline with a ``* `` prefix so they stand out in subtitle editors:

  * word_split   — text split at word level (phrasing may be awkward)
  * split_failed — text could not be split; snapped across full EN range
  * orphan_fi    — unmatched target dialogue, kept at original (legacy) time
  * omission     — EN line with no target counterpart; ``* [PUUTTUU]`` placeholder

Signs / forced narrative (ALL CAPS or quoted target-only cues) are kept at
their original timecodes and left **unflagged** — they are intentional
translations of on-screen text and are timed to the visual, not to dialogue.

Approach:
  1. Embed both cue sets and run the same Needleman-Wunsch alignment as
     align.py, but keep ALL pairs above a low similarity floor (no anchor
     filtering) so we get the complete correspondence.
  2. Walk the aligned pairs in order. A matched target cue covers the
     reference range [i_k .. i_{k+1}-1], but the range is only extended
     across temporally contiguous reference cues (gap <= MAX_SPAN_GAP);
     reference cues after a scene pause have no target counterpart.
  3. For each covered reference range of size N:
       - N == 1: snap text to the reference timecodes (original line layout)
       - N  > 1: split the text into N fragments — recursively on natural
                 boundaries (dialogue dash > line break > sentence end >
                 clause), falling back to a duration-weighted word-level
                 split — and give each fragment its reference cue's exact
                 timecodes. Word-level splits are flagged ``*`` for review.
  4. Unmatched target cues are classified as signs (ALL CAPS / quoted) or
     orphaned dialogue and kept at their original timecodes.
  5. Runs of uncovered reference cues bounded by matched cues on both sides
     are detected as missing lines and filled with ``* [PUUTTUU]`` markers.

Usage:
    python3 retime.py <reference.srt> <target.srt> <out.srt> [out.issues.json]

Prints a JSON summary (including verdict) to stdout.
"""

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from align import build_similarity_matrix, align_sequences  # noqa: E402

# ---------------- CONFIG TUNABLES ---------------- #

# Pairs below this similarity are treated as unmatched (gaps).
MIN_PAIR_SIM = 0.25

# Max time gap between consecutive reference cues for them to be considered
# part of the same exchange (and thus coverable by one target cue).
MAX_SPAN_GAP = 2.0

# Verdict thresholds.
REJECT_COVERAGE = 0.50    # matched fraction of target cues below this -> reject
REJECT_MIN_PAIRS = 10     # fewer matched pairs than this -> reject
REVIEW_SPLIT_FAIL = 0.05  # hard split-failure fraction above this -> review
REVIEW_WORD_SPLIT = 0.15  # word-level split fraction above this -> review
REVIEW_DROPPED_FI = 0.02  # dropped target-cue fraction above this -> review

# Minimum text length for an uncovered EN cue to count as a likely omission.
MIN_OMISSION_CHARS = 8

# Line wrapping for generated fragments.
WRAP_COLS = 42


# ---------- SRT loading (line-layout preserving) ----------


@dataclass
class RawCue:
    index: int
    start: float
    end: float
    lines: List[str]

    @property
    def text(self) -> str:
        return " ".join(l for l in self.lines if l)


def parse_time(t: str) -> float:
    m = re.match(r"(\d+):(\d+):(\d+),(\d+)", t.strip())
    if not m:
        return 0.0
    h, m_, s, ms = map(int, m.groups())
    return h * 3600 + m_ * 60 + s + ms / 1000.0


def fmt_time(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def load_srt_lines(path: str) -> List[RawCue]:
    cues: List[RawCue] = []
    block: List[str] = []

    def flush():
        if len(block) >= 2:
            times = re.findall(r"(\d+:\d+:\d+,\d+)", block[1])
            if len(times) == 2:
                lines = [re.sub(r"<.*?>", "", t).strip() for t in block[2:]]
                lines = [l for l in lines if l]
                if lines:
                    cues.append(
                        RawCue(
                            len(cues),
                            parse_time(times[0]),
                            parse_time(times[1]),
                            lines,
                        )
                    )

    with open(path, encoding="utf-8", errors="ignore") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip():
                flush()
                block = []
            else:
                block.append(line.strip())
    flush()
    return cues


# ---------- Text splitting ----------

DASH_SPLIT_RE = re.compile(r"(?:^|(?<=\s))-\s+")
SENT_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+")
CLAUSE_SPLIT_RE = re.compile(r"(?<=[,;])\s+")


def _split_dialogue(text: str) -> List[str]:
    parts = DASH_SPLIT_RE.split(text)
    if len(parts) <= 1:
        return parts
    return [parts[0]] + ["- " + p for p in parts[1:]]


def _clean(parts: List[str]) -> List[str]:
    return [p.strip() for p in parts if p.strip()]


def _merge_to_n(frags: List[str], n: int) -> List[str]:
    frags = list(frags)
    while len(frags) > n:
        best = min(
            range(len(frags) - 1),
            key=lambda k: len(frags[k]) + len(frags[k + 1]),
        )
        frags[best] = frags[best].rstrip() + " " + frags[best + 1].lstrip()
        del frags[best + 1]
    return frags


def _alloc(n: int, weights: List[float]) -> List[int]:
    """Largest-remainder allocation of n units proportional to weights."""
    total = float(sum(weights)) or float(len(weights))
    raw = [n * w / total for w in weights]
    floors = [int(x) for x in raw]
    rem = n - sum(floors)
    order = sorted(range(len(raw)), key=lambda k: raw[k] - floors[k], reverse=True)
    for k in range(max(0, min(rem, len(order)))):
        floors[order[k]] += 1
    return [max(1, a) for a in floors]


def _recursive_split(text: str, lines: List[str], n: int) -> Optional[List[str]]:
    """Split into >= n fragments on natural boundaries, recursing into the
    coarse parts when a single level is not enough. None if impossible."""
    if n <= 1:
        return [text]

    candidates = []
    dial = _clean(_split_dialogue(text))
    if len(dial) > 1:
        candidates.append(dial)
    ln = _clean(lines)
    if len(ln) > 1:
        candidates.append(ln)
    sent = _clean(SENT_SPLIT_RE.split(text))
    if len(sent) > 1:
        candidates.append(sent)
    clau = _clean(CLAUSE_SPLIT_RE.split(text))
    if len(clau) > 1:
        candidates.append(clau)

    for parts in candidates:
        if len(parts) >= n:
            return _merge_to_n(parts, n)
        allocs = _alloc(n, [len(p) for p in parts])
        out: List[str] = []
        for p, a in zip(parts, allocs):
            sub = _recursive_split(p, [p], a)
            if sub is None:
                break
            out.extend(sub)
        if len(out) >= n:
            return _merge_to_n(out, n)

    return None


def _split_words(text: str, n: int, weights: Optional[List[float]]) -> Optional[List[str]]:
    """Last-resort split: distribute words across n fragments proportional to
    the reference cue durations, so text amount matches display time."""
    raw_words = text.split()
    # bind standalone dialogue dashes to the following word so they can never
    # be isolated into a fragment of their own
    words: List[str] = []
    pending_dash = False
    for w in raw_words:
        if re.fullmatch(r"[-–—]+", w):
            pending_dash = True
            continue
        words.append(("- " + w) if pending_dash else w)
        pending_dash = False
    if pending_dash:
        if words:
            words[-1] += " -"
        else:
            return None
    if len(words) < n:
        return None
    if not weights or len(weights) != n:
        weights = [1.0] * n
    total = float(sum(weights)) or float(n)

    cuts: List[int] = []
    acc = 0.0
    for w in weights:
        acc += w
        cuts.append(int(round(len(words) * acc / total)))
    prev = 0
    fixed: List[int] = []
    for c in cuts:
        c = max(c, prev + 1)
        fixed.append(min(c, len(words)))
        prev = fixed[-1]

    frags: List[str] = []
    start = 0
    for c in fixed:
        frags.append(" ".join(words[start:c]))
        start = c
    return _clean(frags)


def split_to_n(
    text: str,
    lines: List[str],
    n: int,
    weights: Optional[List[float]] = None,
) -> Tuple[Optional[List[str]], str]:
    """
    Split text into exactly n fragments.
    Returns (fragments, method) with method in {"natural", "words"} or
    (None, "failed") when even the word-level fallback cannot reach n.
    """
    if n <= 1:
        return [text], "natural"

    frags = _recursive_split(text, lines, n)
    if frags is not None:
        return _merge_to_n(frags, n), "natural"

    frags = _split_words(text, n, weights)
    if frags is not None and len(frags) == n:
        return frags, "words"

    return None, "failed"


def wrap_line(text: str, cols: int = WRAP_COLS) -> List[str]:
    words = text.split()
    if not words:
        return [text]
    out: List[str] = []
    cur = words[0]
    for w in words[1:]:
        if len(cur) + 1 + len(w) <= cols:
            cur += " " + w
        else:
            out.append(cur)
            cur = w
    out.append(cur)
    return out


# ---------- Classification helpers ----------


def is_sign(cue: RawCue) -> bool:
    """True if the cue looks like a sign / forced-narrative translation:
    ALL CAPS (majority uppercase letters) or wrapped in quote marks."""
    text = cue.text.strip()
    if not text:
        return False
    if any(q in cue.text for q in ('"', '\u201c', '\u201d')):
        return True
    letters = [ch for ch in text if ch.isalpha()]
    if letters:
        upper = sum(1 for ch in letters if ch.isupper())
        if upper / len(letters) > 0.5:
            return True
    return False


def detect_omissions(
    en_cues: List[RawCue],
    uncovered_en: List[RawCue],
    covered_en_idx: set,
) -> List[RawCue]:
    """Find runs of uncovered reference cues that are interior, temporally
    contiguous (gap < MAX_SPAN_GAP within the run), bounded by covered cues
    on both sides, with at least one cue having text >= MIN_OMISSION_CHARS.
    These are likely lines the target subtitle omitted entirely."""
    if not covered_en_idx:
        return []

    unc_idx = {c.index for c in uncovered_en}
    en_by_idx = {c.index: c for c in en_cues}

    covered_sorted = sorted(covered_en_idx)
    first_cov, last_cov = covered_sorted[0], covered_sorted[-1]

    runs: List[List[RawCue]] = []
    cur: List[RawCue] = []
    for c in en_cues:
        if c.index in unc_idx:
            cur.append(c)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)

    omissions: List[RawCue] = []
    for run in runs:
        if run[0].index <= first_cov or run[-1].index >= last_cov:
            continue
        prev_c = en_by_idx.get(run[0].index - 1)
        next_c = en_by_idx.get(run[-1].index + 1)
        if not prev_c or prev_c.index not in covered_en_idx:
            continue
        if not next_c or next_c.index not in covered_en_idx:
            continue
        contig = all(
            en_by_idx[run[k].index + 1].start - run[k].end < MAX_SPAN_GAP
            for k in range(len(run) - 1)
        )
        if not contig:
            continue
        if not any(len(x.text) >= MIN_OMISSION_CHARS for x in run):
            continue
        omissions.extend(run)
    return omissions


# ---------- Alignment-driven regrouping ----------


def group_blocks(
    en_cues: List[RawCue],
    fi_cues: List[RawCue],
    pairs: List[tuple],
) -> dict:
    """
    Assign every kept pair (en_idx, fi_idx, sim) a reference span:
    fi cue k covers en cues [i_k .. ], extended only across temporally
    contiguous reference cues (gap <= MAX_SPAN_GAP) and never past the next
    match. Unmatched fi cues are collected separately (not merged).
    """
    kept = sorted(pairs, key=lambda p: p[1])
    matched_fi_idx = {j for _, j, _ in kept}

    blocks = []
    for k, (i, j, s) in enumerate(kept):
        next_i = kept[k + 1][0] if k + 1 < len(kept) else len(en_cues)

        span = [i]
        cur = i
        while cur + 1 < next_i:
            nxt = cur + 1
            if en_cues[nxt].start - en_cues[cur].end > MAX_SPAN_GAP:
                break
            span.append(nxt)
            cur = nxt

        blocks.append({"en_span": span, "fi": fi_cues[j], "sim": s})

    orphan_fi = [c for c in fi_cues if c.index not in matched_fi_idx]

    covered_en = set()
    for b in blocks:
        covered_en.update(b["en_span"])
    uncovered_en = [c for c in en_cues if c.index not in covered_en]

    return {
        "blocks": blocks,
        "orphan_fi": orphan_fi,
        "uncovered_en": uncovered_en,
        "covered_en_idx": covered_en,
    }


# ---------- Output generation ----------


def build_output(en_cues, fi_cues, grouped) -> tuple:
    out_cues = []  # (start, end, lines, flagged)
    issues = []
    stats = {
        "snapped": 0,
        "split_natural": 0,
        "split_words": 0,
        "split_failed": 0,
        "orphan_fi": 0,
        "signs": 0,
        "omissions": 0,
    }

    covered_en_idx = grouped["covered_en_idx"]

    # --- matched blocks: snap or split ---
    for b in grouped["blocks"]:
        fi = b["fi"]
        span = b["en_span"]

        if len(span) == 1:
            en = en_cues[span[0]]
            out_cues.append((en.start, en.end, list(fi.lines), False))
            stats["snapped"] += 1
            continue

        weights = [max(0.2, en_cues[t].end - en_cues[t].start) for t in span]
        frags, method = split_to_n(fi.text, list(fi.lines), len(span), weights)

        if frags is None:
            start = en_cues[span[0]].start
            end = en_cues[span[-1]].end
            out_cues.append((start, end, list(fi.lines), True))
            stats["split_failed"] += 1
            issues.append(
                {
                    "type": "split_failed",
                    "fi_index": fi.index,
                    "en_range": [span[0], span[-1]],
                }
            )
        else:
            flagged = method == "words"
            for t, frag in zip(span, frags):
                en = en_cues[t]
                out_cues.append((en.start, en.end, wrap_line(frag), flagged))
            stats[f"split_{method}"] += 1
            if flagged:
                issues.append(
                    {
                        "type": "word_split",
                        "fi_index": fi.index,
                        "en_range": [span[0], span[-1]],
                    }
                )

    # --- orphan FI: sign (unflagged) or orphan dialogue (flagged) ---
    for c in grouped["orphan_fi"]:
        if is_sign(c):
            out_cues.append((c.start, c.end, list(c.lines), False))
            stats["signs"] += 1
            issues.append({"type": "sign", "fi_index": c.index})
        else:
            out_cues.append((c.start, c.end, list(c.lines), True))
            stats["orphan_fi"] += 1
            issues.append({"type": "orphan_fi", "fi_index": c.index})

    # --- missing lines: omission placeholders ---
    omissions = detect_omissions(en_cues, grouped["uncovered_en"], covered_en_idx)
    for c in omissions:
        out_cues.append((c.start, c.end, ["* [PUUTTUU]"], True))
        stats["omissions"] += 1
        issues.append({"type": "omission", "en_index": c.index})

    out_cues.sort(key=lambda x: x[0])
    return out_cues, issues, stats


def write_srt(path: str, out_cues) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for idx, (start, end, lines, flagged) in enumerate(out_cues, 1):
            out_lines = list(lines)
            if flagged and out_lines and not out_lines[0].startswith("*"):
                out_lines[0] = "* " + out_lines[0]
            f.write(f"{idx}\n")
            f.write(f"{fmt_time(start)} --> {fmt_time(end)}\n")
            for l in out_lines:
                f.write(l + "\n")
            f.write("\n")


# ---------- Main ----------


def main():
    ap = argparse.ArgumentParser(
        description="Re-time target subtitle onto reference timecodes"
    )
    ap.add_argument("reference", help="in-sync reference SRT (timecode template)")
    ap.add_argument("target", help="legacy target SRT (text source)")
    ap.add_argument("out", help="output corrected SRT path")
    ap.add_argument(
        "issues_out", nargs="?", help="issues JSON path (default: <out>.issues.json)"
    )
    ap.add_argument("--min-pair-sim", type=float, default=MIN_PAIR_SIM)
    args = ap.parse_args()

    issues_path = args.issues_out or (args.out + ".issues.json")

    en_cues = load_srt_lines(args.reference)
    fi_cues = load_srt_lines(args.target)

    if not en_cues or not fi_cues:
        print(json.dumps({"error": "empty_subtitles", "verdict": "reject"}))
        sys.exit(1)

    from fastembed import TextEmbedding

    model_name = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    embedder = TextEmbedding(model_name=model_name)

    ref_vecs = list(embedder.embed([c.text for c in en_cues]))
    tgt_vecs = list(embedder.embed([c.text for c in fi_cues]))

    sim = build_similarity_matrix(en_cues, fi_cues, ref_vecs, tgt_vecs)
    aligned = align_sequences(sim)
    pairs = [(i, j, s) for (i, j, s) in aligned if s >= args.min_pair_sim]

    grouped = group_blocks(en_cues, fi_cues, pairs)
    out_cues, issues, stats = build_output(en_cues, fi_cues, grouped)

    write_srt(args.out, out_cues)

    matched_fi = len(grouped["blocks"])
    coverage_fi = matched_fi / len(fi_cues)
    coverage_en = len(grouped["covered_en_idx"]) / len(en_cues)

    split_fail_frac = stats["split_failed"] / max(1, matched_fi)
    word_split_frac = stats["split_words"] / max(1, matched_fi)
    orphan_frac = stats["orphan_fi"] / len(fi_cues)

    if coverage_fi < REJECT_COVERAGE or matched_fi < REJECT_MIN_PAIRS:
        verdict = "reject"
    elif (
        split_fail_frac > REVIEW_SPLIT_FAIL
        or word_split_frac > REVIEW_WORD_SPLIT
        or orphan_frac > REVIEW_DROPPED_FI
    ):
        verdict = "review"
    else:
        verdict = "ok"

    summary = {
        "ref_path": args.reference,
        "target_path": args.target,
        "out_path": args.out,
        "ref_count": len(en_cues),
        "target_count": len(fi_cues),
        "matched_pairs": matched_fi,
        "coverage_fi": round(coverage_fi, 3),
        "coverage_ref": round(coverage_en, 3),
        "out_cues": len(out_cues),
        **stats,
        "uncovered_ref": len(grouped["uncovered_en"]),
        "issue_count": len(issues),
        "verdict": verdict,
        "issues": issues,
    }

    with open(issues_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
