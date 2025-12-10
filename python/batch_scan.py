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
RESYNC_ROOT = DATA_ROOT / "resync"
SUMMARY_CSV = DATA_ROOT / "syncorbit_library_summary.csv"
IGNORE_FILE = DATA_ROOT / "ignore_list.json"

ALIGN_PY = "python/align.py"

# ----------------------------
# Helpers
# ----------------------------


def load_ignore_list():
    if IGNORE_FILE.exists():
        try:
            return set(json.load(open(IGNORE_FILE)))
        except:
            return set()
    return set()


ignored = load_ignore_list()
print(f"Ignored movies: {len(ignored)}")


def load_scores(movie):
    """Return dictionary with whisper + ffsubsync scores (if available)."""
    analysis_path = ANALYSIS_ROOT / movie / "analysis.syncinfo"
    if not analysis_path.exists():
        return {}

    try:
        with open(analysis_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("ref_candidates", {})
    except:
        return {}


def choose_reference(movie, whisper_exists, ffsync_path, en_fi_pair):
    """
    Decide which reference to use based on available metadata.
    Priority:
    1. Whisper if it exists AND has anchor_count > 200
    2. FFSUBSYNC EN if normalized_score > 100
    3. Else fallback to EN/FI pairing
    """
    scores = load_scores(movie)

    # Whisper metrics
    whisper_score = None
    if "whisper_ref" in scores:
        w = scores["whisper_ref"]
        whisper_score = w.get("anchor_count", 0)

    # FF sync metrics
    ff_score = None
    if "ffsubsync_en" in scores:
        f = scores["ffsubsync_en"]
        ff_score = f.get("normalized", 0)

    # Decision logic
    if whisper_exists and whisper_score and whisper_score > 200:
        return "whisper"

    if ffsync_path.exists() and ff_score and ff_score > 100:
        return "ffsync"

    return "fallback"


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
        if movie in ignored:
            print(f"→ Skipping (ignored): {movie}")
            continue

        syncinfo_path = ANALYSIS_ROOT / movie / "analysis.syncinfo"
        whisper_ref_path = REF_ROOT / movie / "ref.srt"

        ref = None
        tgt = None
        use_whisper = False

        # --------------------------------------------------
        # Reference choice section (NEW)
        # --------------------------------------------------

        resync_ref_path = RESYNC_ROOT / movie / "en.resync.srt"
        whisper_exists = whisper_ref_path.exists()
        decision = choose_reference(movie, whisper_exists, resync_ref_path, None)

        ref = None
        use_whisper = False

        if decision == "whisper" and whisper_exists:
            print(f"→ Choosing Whisper reference for {movie}")
            ref = whisper_ref_path
            use_whisper = True

        elif decision == "ffsync" and resync_ref_path.exists():
            print(f"→ Choosing ffsubsync EN reference for {movie}")
            ref = resync_ref_path

        else:
            print(f"→ Using fallback EN/FI pair for {movie}")
            pair = find_en_fi_pair(folder)
            if not pair:
                print(f"→ No EN/FI pair found, skipping {movie}")
                continue
            ref, tgt = pair

        # Find FI subtitle if needed
        if ref is not None and tgt is None:
            for srt in folder.glob("*.srt"):
                name = srt.stem.lower()
                if name.endswith(("fi", "fin")):
                    tgt = srt
                    break
            if tgt is None:
                print(f"→ No FI subtitle found for {movie}, skipping")
                continue

        # --------------------------------------------------
        # Decide whether to reuse analysis or re-align
        # --------------------------------------------------
        analyze = False

        if not syncinfo_path.exists():
            analyze = True
        else:
            try:
                sync_mtime = syncinfo_path.stat().st_mtime
                ref_mtime = ref.stat().st_mtime
                tgt_mtime = tgt.stat().st_mtime

                # Whisper reference fresher than analysis → reanalyze
                if use_whisper and ref_mtime > sync_mtime:
                    analyze = True

                # Target subtitle fresher → reanalyze
                elif tgt_mtime > sync_mtime or ref_mtime > sync_mtime:
                    analyze = True

            except OSError:
                analyze = True

        # --------------------------------------------------
        # Case 1: reuse existing syncinfo
        # --------------------------------------------------
        if not analyze:
            try:
                with open(syncinfo_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                append_summary(movie, data)
                continue
            except Exception as e:
                analyze = True

        # --------------------------------------------------
        # Case 2: Need to run aligner
        # --------------------------------------------------
        try:
            data = run_align(ref, tgt)
        except Exception as e:
            print(f"ERROR:", e)
            continue

        write_syncinfo(movie, data)
        append_summary(movie, data)
        print(f"✔ Done: {movie} ({data['decision']})")

    print("Batch scan complete.")


if __name__ == "__main__":
    main()
