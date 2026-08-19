#!/usr/bin/env python3
import sys
import json
import re
import os
import tempfile
import subprocess
from statistics import mean, median

PY = os.environ.get("PYTHON") or "/app/.venv/bin/python3"
ALIGN_PY = os.environ.get("ALIGN_PY") or "/app/python/align.py"
TIME_RE = re.compile(r"(?P<h>\d{2}):(?P<m>\d{2}):(?P<s>\d{2}),(?P<ms>\d{3})")
DATA_ROOT = os.environ.get("SYNCORBIT_DATA", "/app/data")
AUTOCORRECT_DIR = os.path.join(DATA_ROOT, "autocorrect")


def parse_time(s: str) -> float:
    m = TIME_RE.match(s.strip())
    if not m:
        raise ValueError(f"Bad time code: {s}")
    h = int(m.group("h"))
    m_ = int(m.group("m"))
    s_ = int(m.group("s"))
    ms = int(m.group("ms"))
    return h * 3600 + m_ * 60 + s_ + ms / 1000.0


def format_time(t: float) -> str:
    if t < 0:
        t = 0.0

    total_ms = int(round(t * 1000))
    ms = total_ms % 1000
    total_s = total_ms // 1000

    s_ = total_s % 60
    m_ = (total_s // 60) % 60
    h = total_s // 3600

    return f"{h:02d}:{m_:02d}:{s_:02d},{ms:03d}"


def read_srt(path: str):
    with open(path, "r", encoding="utf-8-sig") as f:
        text = f.read()

    blocks = []
    parts = re.split(r"\n\s*\n", text.strip(), flags=re.MULTILINE)
    for part in parts:
        lines = part.splitlines()
        if len(lines) < 2:
            continue
        idx = lines[0].strip()
        time_line = lines[1].strip()
        rest = lines[2:]
        m = re.match(r"(.*)-->(.*)", time_line)
        if not m:
            continue
        start_raw = m.group(1).strip()
        end_raw = m.group(2).strip()
        start = parse_time(start_raw)
        end = parse_time(end_raw)
        blocks.append(
            {
                "index": idx,
                "start": start,
                "end": end,
                "lines": rest,
            }
        )
    return blocks


def write_srt(blocks, path: str):
    out_lines = []
    for i, b in enumerate(blocks, start=1):
        out_lines.append(str(i))
        out_lines.append(f"{format_time(b['start'])} --> {format_time(b['end'])}")
        out_lines.extend(b["lines"])
        out_lines.append("")
    text = "\n".join(out_lines).strip() + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


# ---------------------------------------------------------
# Piecewise segment detection
# ---------------------------------------------------------


def detect_piecewise_segments(offsets, max_segments=6):
    """
    Given a list of anchor dicts with ref_t / t_ref and delta/offset,
    detect piecewise-constant offset segments along time.
    Returns a list of dicts:
      {
        "t_start": float,
        "t_end": float,
        "median_delta": float,
        "mad": float,
        "count": int,
      }
    """
    if not offsets or len(offsets) < 10:
        return []

    # Normalize fields
    pts = []
    for o in offsets:
        t = o.get("ref_t") or o.get("t_ref") or 0.0
        d = o.get("delta") or o.get("offset") or 0.0
        pts.append((t, d))
    pts.sort(key=lambda x: x[0])

    times = [p[0] for p in pts]
    deltas = [p[1] for p in pts]

    if not deltas:
        return []

    global_med = median(deltas)
    abs_devs = [abs(d - global_med) for d in deltas]
    global_mad = median(abs_devs) or 1e-6

    # A probable "jump" if delta changes more than this between neighbors.
    # Use 1.5x MAD so clean step changes (|diff| == 2*MAD) are detected.
    jump_threshold = max(0.15, 1.5 * global_mad)

    # Minimum anchors per segment
    min_seg_points = max(4, len(pts) // 20)
    segments_idx = []
    start_idx = 0
    for i in range(1, len(pts)):
        d_prev = deltas[i - 1]
        d_now = deltas[i]
        if abs(d_now - d_prev) > jump_threshold and (i - start_idx) >= min_seg_points:
            segments_idx.append((start_idx, i - 1))
            start_idx = i

    # Final segment
    if len(pts) - start_idx >= min_seg_points:
        segments_idx.append((start_idx, len(pts) - 1))

    # Too few segments → don't bother
    if len(segments_idx) < 2:
        return []

    segments = []
    for s, e in segments_idx:
        seg_times = times[s : e + 1]
        seg_deltas = deltas[s : e + 1]
        m = median(seg_deltas)
        mad_loc = median([abs(d - m) for d in seg_deltas]) or 1e-6
        segments.append(
            {
                "t_start": seg_times[0],
                "t_end": seg_times[-1],
                "median_delta": m,
                "mad": mad_loc,
                "count": len(seg_deltas),
            }
        )

    # Drop consecutive segments that aren't meaningfully separated — this
    # prevents a single noisy anchor from being interpreted as a real jump.
    if len(segments) >= 2:
        kept = [segments[0]]
        for cur in segments[1:]:
            if abs(cur["median_delta"] - kept[-1]["median_delta"]) >= 0.25:
                kept.append(cur)
        segments = kept

    # Basic sanity: limit segment count
    segments = segments[:max_segments]

    return segments


# ---------------------------------------------------------
# Binning + linear fit helpers
# ---------------------------------------------------------


def bin_offsets(offsets, n_bins=12):
    """
    Return median delta per time bin: [(t_mid, median_delta), ...].
    Smooths per-cue jitter caused by differing line lengths / cue boundaries.
    """
    pts = sorted(
        [
            (
                o.get("ref_t") or o.get("t_ref") or 0.0,
                o.get("delta") or o.get("offset") or 0.0,
            )
            for o in offsets
        ],
        key=lambda x: x[0],
    )
    if not pts:
        return []
    if len(pts) < n_bins:
        return [(p[0], p[1]) for p in pts]

    k = max(1, len(pts) // n_bins)
    bins = []
    for i in range(0, len(pts), k):
        grp = pts[i : i + k]
        if not grp:
            continue
        bins.append(
            (median([p[0] for p in grp]), median([p[1] for p in grp]))
        )
    return bins


def linear_fit(points):
    """
    Fit d ~ a * t + b over points [(t, d)].
    Returns (slope, intercept, r2, residual_span).
    """
    if len(points) < 2:
        return 0.0, 0.0, 0.0, 0.0
    ts = [p[0] for p in points]
    ds = [p[1] for p in points]

    t_mean = mean(ts)
    d_mean = mean(ds)
    num = sum((t - t_mean) * (d - d_mean) for t, d in zip(ts, ds))
    den = sum((t - t_mean) ** 2 for t in ts) or 1e-9
    a = num / den
    b = d_mean - a * t_mean

    resid = [d - (a * t + b) for t, d in zip(ts, ds)]
    ss_tot = sum((d - d_mean) ** 2 for d in ds) or 1e-9
    ss_res = sum(r * r for r in resid)
    r2 = 1.0 - ss_res / ss_tot
    return a, b, r2, (max(resid) - min(resid))


# ---------------------------------------------------------
# Method selection
# ---------------------------------------------------------


def choose_method(syncinfo: dict) -> str:
    anchors = syncinfo.get("anchor_count") or syncinfo.get("raw_anchor_count") or 0

    clean_offsets = syncinfo.get("clean_offsets") or []
    offsets = clean_offsets or (syncinfo.get("offsets") or [])

    if anchors < 10 or not offsets:
        return "whisper_required"

    # Prefer the smoothed (binned) drift metric
    drift_span = syncinfo.get("drift_span_sec")
    if drift_span is None:
        drift_span = syncinfo.get("robust_drift_span_sec")
    if drift_span is None:
        deltas = [o.get("delta") or o.get("offset") or 0.0 for o in offsets]
        drift_span = max(deltas) - min(deltas) if deltas else 0.0

    # 1) Small smoothed drift overall → pure global offset
    if drift_span < 0.7:
        return "global_offset"

    # 2) Check for piecewise segments
    segments = detect_piecewise_segments(offsets)
    if segments:
        return "piecewise"

    # 3) Strong linear trend → stretch + offset
    if len(offsets) >= 5:
        bins = bin_offsets(offsets)
        a, _b, r2, res_span = linear_fit(bins)
        if len(bins) >= 3 and r2 > 0.85 and abs(a) < 0.004 and res_span < 1.2:
            return "stretch_offset"

    # 4) Low per-cue spread → a global offset is still safe
    mad = syncinfo.get("mad_offset_sec")
    if mad is None:
        deltas = [o.get("delta") or o.get("offset") or 0.0 for o in offsets]
        mad = median([abs(d - median(deltas)) for d in deltas]) if deltas else 0.0
    if mad <= 0.6:
        return "global_offset"

    return "whisper_required"


# ---------------------------------------------------------
# Correction methods
# ---------------------------------------------------------


def apply_global_offset(blocks, syncinfo: dict):
    avg = syncinfo.get("median_offset_sec")
    if avg is None:
        avg = syncinfo.get("avg_offset_sec")

    if avg is None:
        offsets = syncinfo.get("clean_offsets") or syncinfo.get("offsets") or []
        deltas = [o.get("delta") or o.get("offset") or 0.0 for o in offsets]
        if not deltas:
            raise ValueError("No offsets for global correction")
        deltas_sorted = sorted(deltas)
        mid = len(deltas_sorted) // 2
        if len(deltas_sorted) % 2:
            avg = deltas_sorted[mid]
        else:
            avg = 0.5 * (deltas_sorted[mid - 1] + deltas_sorted[mid])

    shift = -avg
    out = []
    for b in blocks:
        out.append(
            {
                "start": b["start"] + shift,
                "end": b["end"] + shift,
                "lines": b["lines"],
            }
        )
    return out, {"method": "global_offset", "shift_sec": shift}


def apply_stretch_offset(blocks, syncinfo: dict):
    offsets = syncinfo.get("clean_offsets") or syncinfo.get("offsets") or []
    if len(offsets) < 5:
        raise ValueError("Not enough offsets for stretch correction")

    # Fit on binned medians so individual cue jitter doesn't skew the fit
    bins = bin_offsets(offsets)
    if len(bins) < 3:
        raise ValueError("Not enough bins for stretch correction")

    a, b, _r2, _res = linear_fit(bins)

    # offset(t) ≈ a * t + b
    # We want corrected T' = T - offset(T)
    # ≈ T - (a*T + b) = T*(1 - a) - b
    stretch = 1.0 - a
    shift = -b

    out = []
    for b_ in blocks:
        s = b_["start"]
        e = b_["end"]
        s_corr = s * stretch + shift
        e_corr = e * stretch + shift
        out.append(
            {
                "start": s_corr,
                "end": e_corr,
                "lines": b_["lines"],
            }
        )
    return out, {
        "method": "stretch_offset",
        "stretch": stretch,
        "shift_sec": shift,
    }


def apply_piecewise(blocks, syncinfo: dict):
    offsets = syncinfo.get("clean_offsets") or syncinfo.get("offsets") or []
    segments = detect_piecewise_segments(offsets)
    # if not segments or len(segments) < 2:
    #      raise ValueError("Not enough good segments for piecewise correction")
    if not segments:
        raise ValueError("No usable segments for piecewise correction")

    # Sort segments by time just to be sure
    segments.sort(key=lambda s: s["t_start"])

    def pick_segment(time_sec: float):
        # Prefer segment containing time; fallback to nearest
        containing = [s for s in segments if s["t_start"] <= time_sec <= s["t_end"]]
        if containing:
            # if multiple, pick narrowest
            return min(containing, key=lambda s: s["t_end"] - s["t_start"])
        # else nearest by center
        return min(
            segments,
            key=lambda s: abs(((s["t_start"] + s["t_end"]) / 2.0) - time_sec),
        )

    out = []
    for b in blocks:
        mid_t = 0.5 * (b["start"] + b["end"])
        seg = pick_segment(mid_t)
        # shift against that segment's median
        shift = -seg["median_delta"]
        print(
            f"[AC] t={mid_t:.1f}s  segΔ={seg['median_delta']:.3f}s  shift={-seg['median_delta']:.3f}s",
            file=sys.stderr,
        )
        out.append(
            {
                "start": b["start"] + shift,
                "end": b["end"] + shift,
                "lines": b["lines"],
            }
        )

    meta = {
        "method": "piecewise",
        "segment_count": len(segments),
        "segments": segments,
    }
    return out, meta


def run_align_eval(ref_path: str, target_path: str) -> dict:
    cmd = [
        PY,
        ALIGN_PY,
        ref_path,
        target_path,
    ]

    p = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    if p.returncode != 0:
        raise RuntimeError(f"align eval failed: {p.stderr.strip() or p.stdout.strip()}")

    raw = p.stdout.strip()
    if not raw:
        raise RuntimeError("align eval produced no output")

    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"align eval did not return valid JSON: {e}\nRAW:\n{raw[:500]}"
        )


def downgrade(verdict: str) -> str:
    if verdict == "accept":
        return "review"
    return "reject"


def verdict_from_metrics(before: dict, after: dict, extra: dict) -> dict:
    # Required fields
    db = float(before.get("drift_span_sec") or before.get("drift_span") or 0.0)
    da = float(after.get("drift_span_sec") or after.get("drift_span") or 0.0)
    ab = int(before.get("anchor_count") or 0)
    aa = int(after.get("anchor_count") or 0)
    ob = abs(float(before.get("avg_offset_sec") or 0.0))
    oa = abs(float(after.get("avg_offset_sec") or 0.0))

    # Guard against divide by zero
    if db <= 1e-6:
        # If drift was essentially zero, there's nothing to improve drift-wise.
        base_verdict = "reject"
        ratio = None
    else:
        ratio = da / db
        if ratio <= 0.5 and da <= 0.6:
            base_verdict = "accept"
        elif ratio <= 0.8:
            base_verdict = "review"
        else:
            base_verdict = "reject"

    # A big constant offset is a real problem that a global shift fixes well,
    # even though drift (which is shift-invariant) doesn't change.
    offset_improved = ob > 1.0 and oa <= 0.5 * ob
    if offset_improved and base_verdict == "reject":
        base_verdict = "review"
    if offset_improved and base_verdict == "review" and da <= 0.6:
        base_verdict = "accept"

    verdict = base_verdict

    # Safety downgrades
    if ab > 0 and aa < 0.8 * ab:
        verdict = downgrade(verdict)

    max_shift = float(extra.get("max_shift_sec") or 0.0)
    if abs(max_shift) > 1.0:
        verdict = downgrade(verdict)

    return {
        "verdict": verdict,
        "improvement_ratio": ratio,
        "reasons": {
            "drift_before": db,
            "drift_after": da,
            "anchors_before": ab,
            "anchors_after": aa,
            "offset_before": ob,
            "offset_after": oa,
            "max_shift_sec": max_shift,
        },
    }


# ---------------------------------------------------------
# CLI
# ---------------------------------------------------------


def main():
    if len(sys.argv) < 3:
        print(
            "Usage: autocorrect.py TARGET_SRT ANALYSIS_SYNCINFO [OUT_SRT]",
            file=sys.stderr,
        )
        sys.exit(1)

    target_srt = sys.argv[1]
    syncinfo_path = sys.argv[2]

    # Ensure output directory exists
    os.makedirs(AUTOCORRECT_DIR, exist_ok=True)

    if len(sys.argv) >= 4:
        # Explicit output path (caller knows what they’re doing)
        out_srt = sys.argv[3]
    else:
        # Default: write to autocorrect dir, never to media
        base_name = os.path.basename(target_srt)
        name, ext = os.path.splitext(base_name)
        out_srt = os.path.join(
            AUTOCORRECT_DIR,
            f"{name}.corrected{ext}",
        )

    try:
        with open(syncinfo_path, "r", encoding="utf-8") as f:
            syncinfo = json.load(f)
    except Exception as e:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": "bad_syncinfo",
                    "detail": str(e),
                }
            ),
            flush=True,
        )
        sys.exit(0)

    blocks = read_srt(target_srt)
    method = choose_method(syncinfo)

    if method == "whisper_required":
        print(
            json.dumps(
                {
                    "status": "whisper_required",
                    "method": method,
                    "output_file": None,
                }
            ),
            flush=True,
        )
        sys.exit(0)

    try:
        if method == "global_offset":
            new_blocks, meta = apply_global_offset(blocks, syncinfo)
        elif method == "stretch_offset":
            new_blocks, meta = apply_stretch_offset(blocks, syncinfo)
        elif method == "piecewise":
            new_blocks, meta = apply_piecewise(blocks, syncinfo)
        else:
            print(
                json.dumps(
                    {
                        "status": "whisper_required",
                        "method": method,
                        "output_file": None,
                    }
                ),
                flush=True,
            )
            sys.exit(0)

        write_srt(new_blocks, out_srt)

        # --- BEFORE metrics (from original syncinfo) ---
        before = {
            "anchor_count": int(syncinfo.get("anchor_count") or 0),
            "drift_span_sec": float(syncinfo.get("drift_span_sec") or 0.0),
            "avg_offset_sec": float(syncinfo.get("avg_offset_sec") or 0.0),
        }

        # --- AFTER metrics (re-align corrected subtitle) ---
        after_sync = run_align_eval(syncinfo["ref_path"], out_srt)

        after = {
            "anchor_count": int(after_sync.get("anchor_count") or 0),
            "drift_span_sec": float(after_sync.get("drift_span_sec") or 0.0),
            "avg_offset_sec": float(after_sync.get("avg_offset_sec") or 0.0),
        }

        max_shift = 0.0
        if meta.get("segments"):
            shifts = [-s["median_delta"] for s in meta["segments"]]
            if shifts:
                max_shift = max(abs(s) for s in shifts)

        shifts = []
        if meta.get("segments"):
            shifts = [-s["median_delta"] for s in meta["segments"]]

        shift_stats = {
            "min_sec": min(shifts) if shifts else 0.0,
            "max_sec": max(shifts) if shifts else 0.0,
            "median_sec": median(shifts) if shifts else 0.0,
        }

        extra = {
            "max_shift_sec": max_shift,
        }

        notes = []

        if after["drift_span_sec"] > 1.5:
            notes.append("drift still large after correction")

        if abs(shift_stats["min_sec"]) > 0.5 or abs(shift_stats["max_sec"]) > 0.5:
            notes.append("large shift applied in at least one segment")

        if after["anchor_count"] < 0.8 * before["anchor_count"]:
            notes.append("anchor count dropped significantly")

        verdict_info = verdict_from_metrics(before, after, extra)

        result = {
            "status": "ok",
            "method": meta.get("method", "piecewise"),
            "output_file": os.path.basename(out_srt),
            "before": before,
            "after": after,
            "shifts": shift_stats,
            "segments": {"count": meta.get("segment_count", 0)},
            "verdict": verdict_info["verdict"],
            "improvement_ratio": verdict_info["improvement_ratio"],
            "notes": notes,
        }

        result.update(verdict_info)

        print(json.dumps(result))

    except Exception as e:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": "correction_failed",
                    "detail": str(e),
                }
            ),
            flush=True,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
