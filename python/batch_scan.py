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
DATA_DIR = os.environ.get("SYNCORBIT_DATA", "/app/data")
SUMMARY_CSV = os.path.join(DATA_DIR, "syncorbit_library_summary.csv")


ALIGN_PY = "python/align.py"


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


def write_summary_header(csv_path: Path):
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["movie", "anchors", "avg_offset", "drift_span", "decision"])


def write_summary_line(csv_path: Path, folder_name: str, data: dict):
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                folder_name,
                data.get("anchor_count", 0),
                data.get("avg_offset_sec", 0.0),
                data.get("drift_span_sec", 0.0),
                data.get("decision", "unknown"),
            ]
        )


def main():
    root = Path(ROOT)
    summary_path = Path(SUMMARY_CSV)

    # Always rebuild CSV fresh
    write_summary_header(summary_path)

    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue

        folder_name = folder.name
        syncinfo = folder / SYNCINFO_NAME

        if syncinfo.exists():
            # reuse existing analysis
            try:
                with open(syncinfo, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                print(f"→ ERROR reading {syncinfo}, re-aligning.")
                data = None
        else:
            data = None

        if not data:
            # need fresh analysis
            subpair = find_subtitles(folder)
            if not subpair:
                print(f"→ No subtitle pair in {folder_name}")
                continue

            ref, tgt = subpair
            print(f"→ Aligning {ref.name} <-> {tgt.name}")

            try:
                data = run_align(ref, tgt)
            except Exception as e:
                print(f"ERROR: {e}")
                continue

            write_syncinfo(folder, data)

        # write CSV row
        write_summary_line(summary_path, folder_name, data)

        print(f"✔ {folder_name}: {data['decision']}")

    print("Batch scan complete.")


if __name__ == "__main__":
    main()
