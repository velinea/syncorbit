#!/usr/bin/env python3
"""
Batch scanner for SyncOrbit.

Walks a movie library and generates:
    - <movie>.syncinfo under SYNCORBIT_DATA/analysis
    - syncorbit_library_summary.csv under SYNCORBIT_DATA
"""

import csv
import json
import os
import subprocess
from pathlib import Path

ROOT = "/app/media"  # mounted media root
DATA_DIR = os.environ.get("SYNCORBIT_DATA", "/app/data")
ANALYSIS_DIR = Path(DATA_DIR) / "analysis"
SUMMARY_CSV = Path(DATA_DIR) / "syncorbit_library_summary.csv"

ALIGN_PY = "python/align.py"


def find_subtitles(folder: Path):
    """
    Very simple heuristic: look for EN/FI pairs.
    """
    subs = [f for f in folder.glob("*.srt")]
    if len(subs) < 2:
        return None

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


def write_syncinfo(analysis_root: Path, movie_name: str, data: dict):
    """
    Store analysis under:
        /app/data/analysis/<movie>/analysis.syncinfo
    """
    movie_dir = analysis_root / movie_name
    movie_dir.mkdir(parents=True, exist_ok=True)

    outpath = movie_dir / "analysis.syncinfo"
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def write_summary_line(csv_path: Path, folder_name: str, data: dict):
    """
    Append one row to summary CSV (no header).
    """
    csv_path.parent.mkdir(parents=True, exist_ok=True)
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
    analysis_dir = ANALYSIS_DIR
    summary_path = SUMMARY_CSV

    analysis_dir.mkdir(parents=True, exist_ok=True)

    # Always rebuild CSV fresh (no header)
    if summary_path.exists():
        summary_path.unlink()

    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue

        folder_name = folder.name
        syncinfo_path = analysis_dir / folder_name / "analysis.syncinfo"
        # Prefer Whisper reference if present:
        ref_dir = Path(DATA_DIR) / "ref" / folder_name
        whisper_ref = ref_dir / "ref.srt"

        if whisper_ref.exists():
            # Whisper reference is authoritative; use it as reference
            ref_sub = whisper_ref
            # Still look for target subtitles inside media folder
            tgt_candidates = list(folder.glob("*.srt"))
            # Pick the best FI subtitle
            tgt_sub = None
            for s in tgt_candidates:
                name = s.stem.lower()
                if name.endswith(("fi", "fin")):
                    tgt_sub = s
                    break

            if tgt_sub:
                print(f"→ Using Whisper reference for {folder_name}")
                subpair = (ref_sub, tgt_sub)
            else:
                print(f"→ Whisper found but no FI target: {folder_name}")
                subpair = None
        else:
            subpair = find_subtitles(folder)

        data = None
        if syncinfo_path.exists():
            # reuse existing analysis from /app/data/analysis
            try:
                with open(syncinfo_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                print(f"→ Reusing existing analysis: {folder_name}")
            except Exception:
                print(f"→ ERROR reading {syncinfo_path}, re-aligning.")
                data = None

        if not data:
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

            write_syncinfo(analysis_dir, folder_name, data)

        # write CSV row
        write_summary_line(summary_path, folder_name, data)
        print(f"✔ {folder_name}: {data.get('decision', 'unknown')}")

    print("Batch scan complete.")


if __name__ == "__main__":
    main()
