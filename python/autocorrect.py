#!/usr/bin/env python3
import json
import os
import re
import sys
from statistics import mean

TIME_RE = re.compile(r"(?P<h>\d{2}):(?P<m>\d{2}):(?P<s>\d{2}),(?P<ms>\d{3})")


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
    ms = int(round((t - int(t)) * 1000))
    total = int(t)
    s_ = total % 60
    m_ = (total // 60) % 60
    h = total // 3600
    return f"{h:02d}:{m_:02d}:{s_:02d},{ms:03d}"


def read_srt(path: str):
    with open(path, "r", encoding="utf-8-sig") as f:
        text = f.read()

    # Basic SRT splitting
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
        blocks.append({"index": idx, "start": start, "end": end, "lines": rest})
    return blocks


def write_srt(blocks, path: str):
    out_lines = []
    for i, b in enumerate(blocks, start=1):
        out_lines.append(str(i))
        out_lines.append(f"{format_time(b['start'])} --> {format_time(b['end'])}")
        out_lines.extend(b["lines"])
        out_lines.append("")  # blank line
    text = "\n".join(out_lines).strip() + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def choose_method(syncinfo: dict) -> str:
    # Use robust anchor count & drift
    anchors = syncinfo.get("anchor_count") or 0

    clean_offsets = syncinfo.get("clean_offsets") or []
    offsets = clean_offsets or (syncinfo.get("offsets") or [])

    if anchors < 20 or not offsets:
        return "whisper_required"

    # Prefer robust drift span if available
    drift_span = syncinfo.get("robust_drift_span_sec")
    if drift_span is None:
        deltas = [o.get("delta") or o.get("offset") or 0.0 for o in offsets]
        drift_span = max(deltas) - min(deltas) if deltas else 0.0

    # Very small drift span → global offset is safe
    if drift_span < 0.7:
        return "global_offset"

    # ----- Try to see if it's approximately linear drift -----
    ref_ts = [o.get("ref_t") or o.get("t_ref") or 0.0 for o in offsets]

    # Need enough anchors and enough time coverage
    if len(ref_ts) < 5:
        return "whisper_required"

    time_span = max(ref_ts) - min(ref_ts)
    if time_span < 600:  # < 10 minutes coverage
        return "whisper_required"

    from statistics import mean

    deltas = [o.get("delta") or o.get("offset") or 0.0 for o in offsets]

    t_mean = mean(ref_ts)
    d_mean = mean(deltas)

    num = sum((t - t_mean) * (d - d_mean) for t, d in zip(ref_ts, deltas))
    den = sum((t - t_mean) ** 2 for t in ref_ts) or 1.0
    a = num / den
    b = d_mean - a * t_mean

    ss_tot = sum((d - d_mean) ** 2 for d in deltas) or 1.0
    ss_res = sum((d - (a * t + b)) ** 2 for d, t in zip(deltas, ref_ts))
    r2 = 1.0 - ss_res / ss_tot

    # Heuristic: strong linear trend, but not insane slope
    if r2 > 0.85 and abs(a) < 0.002:
        return "stretch_offset"

    return "whisper_required"

def apply_global_offset(blocks, syncinfo: dict):
    # Prefer robust median offset if available
    avg = syncinfo.get("median_offset_sec")
    if avg is None:
        avg = syncinfo.get("avg_offset_sec")

    if avg is None:
        # fallback to median of clean deltas
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

    # shift against delta (if target is behind by -0.7, we add +0.7)
    shift = -avg
    out = []
    for b in blocks:
        out.append({
            "start": b["start"] + shift,
            "end": b["end"] + shift,
            "lines": b["lines"],
        })
    return out, {"method": "global_offset", "shift_sec": shift}

def apply_stretch_offset(blocks, syncinfo: dict):
    offsets = syncinfo.get("clean_offsets") or syncinfo.get("offsets") or []
    if len(offsets) < 5:
        raise ValueError("Not enough offsets for stretch correction")

    from statistics import mean

    ref_ts = [o.get("ref_t") or o.get("t_ref") or 0.0 for o in offsets]
    deltas = [o.get("delta") or o.get("offset") or 0.0 for o in offsets]

    t_mean = mean(ref_ts)
    d_mean = mean(deltas)

    num = sum((t - t_mean) * (d - d_mean) for t, d in zip(ref_ts, deltas))
    den = sum((t - t_mean) ** 2 for t in ref_ts) or 1.0
    a = num / den
    b = d_mean - a * t_mean

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
        out.append({
            "start": s_corr,
            "end": e_corr,
            "lines": b_["lines"],
        })
    return out, {
        "method": "stretch_offset",
        "stretch": stretch,
        "shift_sec": shift,
    }

def main():
    if len(sys.argv) < 3:
        print(
            "Usage: autocorrect.py TARGET_SRT ANALYSIS_SYNCINFO [OUT_SRT]",
            file=sys.stderr,
        )
        sys.exit(1)

    target_srt = sys.argv[1]
    syncinfo_path = sys.argv[2]
    out_srt = None
    if len(sys.argv) >= 4:
        out_srt = sys.argv[3]

    if out_srt is None:
        base, ext = os.path.splitext(target_srt)
        out_srt = base + ".corrected" + ext

    try:
        with open(syncinfo_path, "r", encoding="utf-8") as f:
            syncinfo = json.load(f)
    except Exception as e:
        print(
            json.dumps({"status": "error", "error": "bad_syncinfo", "detail": str(e)}),
            flush=True,
        )
        sys.exit(0)

    blocks = read_srt(target_srt)
    method = choose_method(syncinfo)

    if method == "whisper_required":
        print(
            json.dumps(
                {"status": "whisper_required", "method": method, "output_file": None}
            ),
            flush=True,
        )
        sys.exit(0)

    try:
        if method == "global_offset":
            new_blocks, meta = apply_global_offset(blocks, syncinfo)
        elif method == "stretch_offset":
            new_blocks, meta = apply_stretch_offset(blocks, syncinfo)
        else:
            # future: piecewise, etc.
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

        print(
            json.dumps(
                {
                    "status": "ok",
                    "method": meta["method"],
                    "output_file": out_srt,
                    "meta": meta,
                }
            ),
            flush=True,
        )
    except Exception as e:
        print(
            json.dumps(
                {"status": "error", "error": "correction_failed", "detail": str(e)}
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
