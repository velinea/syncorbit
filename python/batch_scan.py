#!/usr/bin/env python3
"""
Batch scanner for SyncOrbit.

Walks a movie library and generates:
    - analysis.syncinfo per movie
    - syncorbit_library_summary.csv
"""

import csv
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = "/app/media"  # change as needed
SYNCINFO_NAME = "analysis.syncinfo"
SUMMARY_CSV = "syncorbit_library_summary.csv"

ALIGN_PY = "align.py"


def find_subtitles(folder: Path):
    subs = [f for f in folder.glob("*.srt")]
    if len(subs) < 2:
        return None
    # heuristic: en = longer common base names ending with en.srt or eng.srt
    ref = None
    tgt = None
    for s in subs:
        name = s.stem.lower()
        if name.endswith(("en", "eng")):
            ref = s
        if name.endswith(("fi", "fin")):
            tgt = s
    if ref and tgt:
        return ref, tgt
    return None


def run_align(ref: Path, tgt: Path):
    """Run align.py and return parsed JSON."""
    cmd = ["python3", ALIGN_PY, str(ref), str(tgt)]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout)


def write_syncinfo(folder: Path, data: dict):
    path = folder / SYNCINFO_NAME
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def append_summary_line(csv_path: Path, folder_name: str, data: dict):
    exists = csv_path.exists()
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        # if not exists:
        #     w.writerow(["movie", "anchors", "avg_offset", "drift_span", "decision"])
        w.writerow(
            [
                folder_name,
                data["anchor_count"],
                data["avg_offset_sec"],
                data["drift_span_sec"],
                data["decision"],
            ]
        )


def main():
    root = Path(ROOT)
    summary_path = Path(SUMMARY_CSV)

    print(f"Scanning library: {root}")

    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue

        syncinfo = folder / SYNCINFO_NAME
        if syncinfo.exists():
            print(f"→ Skipping (already processed): {folder.name}")
            continue

        subpair = find_subtitles(folder)
        if not subpair:
            print(f"→ No subtitle pair: {folder.name}")
            continue

        ref, tgt = subpair
        print(f"Aligning {ref.name} <-> {tgt.name}")

        try:
            data = run_align(ref, tgt)
        except Exception as e:
            print("ERROR:", e)
            continue

        data["movie"] = folder.name
        data["folder"] = str(folder)

        write_syncinfo(folder, data)
        append_summary_line(summary_path, folder.name, data)

        print(f"✔ Done: {folder.name} ({data['decision']})")

    print("Batch scan complete.")


if __name__ == "__main__":
    main()
