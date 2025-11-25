#!/usr/bin/env python3
import json
import re
import sys
from datetime import timedelta

time_re = re.compile(r"(\d+):(\d+):(\d+),(\d+)")


def parse_time(t):
    h, m, s, ms = map(int, time_re.match(t).groups())
    return timedelta(hours=h, minutes=m, seconds=s, milliseconds=ms)


def load_srt(path):
    entries = []
    with open(path, encoding="utf-8", errors="ignore") as f:
        block = []
        for line in f:
            line = line.strip()
            if not line:
                if len(block) >= 2:
                    times = re.findall(r"(\d+:\d+:\d+,\d+)", block[1])
                    if len(times) == 2:
                        start, end = map(parse_time, times)
                        entries.append((start.total_seconds(), end.total_seconds()))
                block = []
            else:
                block.append(line)
    return entries


def compare_srt(base_path, ref_path):
    base = load_srt(base_path)
    ref = load_srt(ref_path)
    n = min(len(base), len(ref))
    if n == 0:
        return {"error": "no entries"}

    offsets = [base[i][0] - ref[i][0] for i in range(n)]
    avg_off = sum(offsets) / n
    min_off, max_off = min(offsets), max(offsets)
    drift = max_off - min_off

    samples = [
        {"i": i, "offset": round(offsets[i], 2)} for i in range(0, n, max(1, n // 20))
    ]

    return {
        "pairs": n,
        "avg_offset_sec": round(avg_off, 2),
        "min_offset_sec": round(min_off, 2),
        "max_offset_sec": round(max_off, 2),
        "drift_sec": round(drift, 2),
        "samples": samples,
    }


if __name__ == "__main__":
    base, ref = sys.argv[1], sys.argv[2]
    result = compare_srt(base, ref)
    print(json.dumps(result))
