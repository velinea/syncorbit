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
MEDIA_ROOT = Path("/app/media")  # read-only mount
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
        raise RuntimeError(out.stderr or f"align.py failed with code {out.returncode}")

    data = json.loads(out.stdout)
    # Ensure ref/target paths are stored for UI + autocorrect
    data["ref_path"] = str(ref)
    data["target_path"] = str(tgt)
    return data


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


def append_summary(movie_name: str, data: dict):
    """
    Append one summary row. No header.
    """
    SUMMARY_CSV.parent.mkdir(parents=True, exist_ok=True)

    with open(SUMMARY_CSV, "a", newline="", encoding="utf-8") as f:
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
    ANALYSIS_ROOT.mkdir(parents=True, exist_ok=True)

    # Always rebuild CSV fresh each run
    if SUMMARY_CSV.exists():
        SUMMARY_CSV.unlink()

    print(f"Scanning library: {MEDIA_ROOT}")

    for folder in sorted(MEDIA_ROOT.iterdir()):
        if not folder.is_dir():
            continue

        movie = folder.name

        syncinfo_path = ANALYSIS_ROOT / movie / "analysis.syncinfo"
        whisper_ref_path = REF_ROOT / movie / "ref.srt"

        # --------------------------------------------------
        # Decide whether to reuse analysis or re-align
        # --------------------------------------------------
        reuse = False
        reanalyze = False

        if syncinfo_path.exists():
            if whisper_ref_path.exists():
                # If we have a Whisper ref and it's newer than analysis -> reanalyze
                try:
                    if whisper_ref_path.stat().st_mtime > syncinfo_path.stat().st_mtime:
                        reanalyze = True
                    else:
                        reuse = True
                except OSError:
                    # If stat fails for some reason, be conservative and reuse
                    reuse = True
            else:
                # No Whisper ref, but we do have analysis -> reuse
                reuse = True

        else:
            # No syncinfo at all -> must analyze
            reanalyze = True

        # --------------------------------------------------
        # Case 1: reuse existing analysis
        # --------------------------------------------------
        if reuse:
            try:
                with open(syncinfo_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                append_summary(movie, data)
                print(f"→ Reusing existing analysis: {movie}")
                continue
            except Exception as e:
                print(f"→ ERROR reading {syncinfo_path}: {e}")
                # fall through to reanalyze

        # --------------------------------------------------
        # Case 2: need to analyze (new or reanalyze)
        # --------------------------------------------------
        ref = None
        tgt = None

        if whisper_ref_path.exists():
            # Whisper reference available -> use it
            ref = whisper_ref_path
            print(f"→ Using Whisper reference for {movie}")

            # Try to find FI subtitle as target in media folder
            for srt in folder.glob("*.srt"):
                name = srt.stem.lower()
                if name.endswith(("fi", "fin")):
                    tgt = srt
                    break

            if not tgt:
                print(f"→ No FI subtitle found for {movie}, skipping")
                continue
        else:
            # Fallback: EN/FI pair inside media
            pair = find_en_fi_pair(folder)
            if not pair:
                print(f"→ No subtitle pair in {movie}")
                continue
            ref, tgt = pair

        print(f"→ Aligning {ref.name} <-> {tgt.name}   [{movie}]")

        try:
            data = run_align(ref, tgt)
        except Exception as e:
            print(f"ERROR aligning {movie}: {e}")
            continue

        write_syncinfo(movie, data)
        append_summary(movie, data)

        print(f"✔ Done: {movie} ({data.get('decision', 'unknown')})")

    print("Batch scan complete.")


if __name__ == "__main__":
    main()
