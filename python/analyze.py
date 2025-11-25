import json
import re
import sys
from datetime import timedelta


def parse_time(t):
    h, m, s, ms = re.match(r"(\d+):(\d+):(\d+),(\d+)", t).groups()
    return timedelta(hours=int(h), minutes=int(m), seconds=int(s), milliseconds=int(ms))


def analyze_srt(path):
    entries = []
    with open(path, encoding="utf-8", errors="ignore") as f:
        block = []
        for line in f:
            if line.strip() == "":
                if len(block) >= 2:
                    times = re.findall(r"(\d+:\d+:\d+,\d+)", block[1])
                    if len(times) == 2:
                        start, end = map(parse_time, times)
                        entries.append((start, end))
                block = []
            else:
                block.append(line.strip())

    if not entries:
        return {"error": "no subtitles"}

    deltas = [
        (entries[i + 1][0] - entries[i][1]).total_seconds()
        for i in range(len(entries) - 1)
    ]
    avg_gap = sum(deltas) / len(deltas)
    negatives = sum(1 for d in deltas if d < 0)
    total_drift = (entries[-1][0] - entries[0][0]).total_seconds()

    return {
        "total": len(entries),
        "avg_gap": round(avg_gap, 3),
        "overlaps": negatives,
        "duration": round(entries[-1][1].total_seconds(), 1),
        "drift_sec": round(total_drift - entries[-1][1].total_seconds(), 3),
    }


if __name__ == "__main__":
    path = sys.argv[1]
    result = analyze_srt(path)
    print(json.dumps(result))
