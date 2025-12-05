#!/usr/bin/env python3
"""
Batch scanner for SyncOrbit.

Creates:
    /app/data/analysis/<movie>/analysis.syncinfo
    /app/data/syncorbit_library_summary.csv

Prefers WhisperX reference in:
    /app/data/ref/<movie>/ref.srt

Falls back to EN/FI subtitle pairs inside /app/media.
"""

import csv
import json
import os
import subprocess
from pathlib import Path

# ----------------------------
# Root paths
# ----------------------------
MEDIA_ROOT = "/app/media"  # read-only mount
DATA_ROOT = Path(os.environ.get("SYNCORBIT_DATA", "/app/data"))

ANALYSIS_ROOT = DATA_ROOT / "analysis"
REF_ROOT = DATA_ROOT / "ref"

SUMMARY_CSV = DATA_ROOT / "syncorbit_library_summary.csv"

ALIGN_PY = "python/align.py"


# ----------------------------
# Helpers
# ----------------------------


def find_en_fi_pair(folder: Path):
    """
    Find English + Finnish subtitle pair INSIDE MEDIA folder (fallback mode).
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
    """Run align.py and parse JSON result."""
    cmd = ["python3", ALIGN_PY, str(ref), str(tgt)]
    out = subprocess.run(cmd, capture_output=True, text=True)

    if out.returncode != 0:
        raise RuntimeError(out.stderr)

    return json.loads(out.stdout)


def write_syncinfo(movie_name: str, data: dict):
    """
    Write analysis JSON to:
        /app/data/analysis/<movie>/analysis.syncinfo
    """
    movie_dir = ANALYSIS_ROOT / movie_name
    movie_dir.mkdir(parents=True, exist_ok=True)

    outpath = movie_dir / "analysis.syncinfo"
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    return outpath


def append_summary(csv_path: Path, movie_name: str, data: dict):
    """
    Append one summary row. No header.
    """
    csv_path.parent.mkdir(parents=True, exist_ok=True)

    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                movie_name,
                data.get("anchor_count", 0),
                data.get("avg_offset_sec", 0.0),
                data.get("drift_span_sec", 0.0),
                data.get("decision", "unknown"),
            ]
        )


# ----------------------------
# Main scanning logic
# ----------------------------


def main():
    media_root = Path(MEDIA_ROOT)

    # Ensure analysis directory exists
    ANALYSIS_ROOT.mkdir(parents=True, exist_ok=True)

    # Remove old CSV so results don't duplicate
    if SUMMARY_CSV.exists():
        SUMMARY_CSV.unlink()

    print(f"Scanning library: {media_root}")

    for folder in sorted(media_root.iterdir()):
        if not folder.is_dir():
            continue

        movie = folder.name

        # path: /app/data/analysis/<movie>/analysis.syncinfo
        syncinfo_path = ANALYSIS_ROOT / movie / "analysis.syncinfo"

        # path: /app/data/ref/<movie>/ref.srt
        whisper_ref_path = REF_ROOT / movie / "ref.srt"

        # ---------------------------------------------
        # If analysis exists, reuse it (no re-aligning)
        # ---------------------------------------------
        if syncinfo_path.exists():
            try:
                with open(syncinfo_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                print(f"→ Reusing existing analysis: {movie}")
                append_summary(SUMMARY_CSV, movie, data)
                continue
            except Exception as e:
                print(f"→ ERROR reading {syncinfo_path}: {e}")
                print(f"→ Will try to re-align {movie}")

        # ---------------------------------------------
        # 1. Prefer Whisper reference if available
        # ---------------------------------------------
        if whisper_ref_path.exists():
            print(f"→ Using Whisper reference for {movie}")
            ref_sub = whisper_ref_path

            # find FI subtitle in media folder
            tgt_sub = None
            for srt in folder.glob("*.srt"):
                name = srt.stem.lower()
                if name.endswith(("fi", "fin")):
                    tgt_sub = srt
                    break

            if not tgt_sub:
                print(f"→ No FI subtitle found for {movie}, skipping")
                continue

            ref, tgt = ref_sub, tgt_sub

        else:
            # ---------------------------------------------
            # 2. Fallback: EN/FI pair inside media
            # ---------------------------------------------
            pair = find_en_fi_pair(folder)
            if not pair:
                print(f"→ No subtitle pair in {movie}")
                continue
            ref, tgt = pair

        # ---------------------------------------------
        # Execute align.py
        # ---------------------------------------------
        print(f"→ Aligning {ref.name} <-> {tgt.name}   [{movie}]")

        try:
            data = run_align(ref, tgt)
        except Exception as e:
            print(f"ERROR aligning {movie}: {e}")
            continue

        # ---------------------------------------------
        # Save results
        # ---------------------------------------------
        write_syncinfo(movie, data)
        append_summary(SUMMARY_CSV, movie, data)

        print(f"✔ Done: {movie} ({data.get('decision')})")

    print("Batch scan complete.")


if __name__ == "__main__":
    main()
