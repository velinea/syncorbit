#!/bin/bash
set -e

MOVIES="/mnt/media/Movies"
DATA="/mnt/media/whisperx"
SYNCORBIT_CSV="$DATA/syncorbit_library_export.csv"
LOG="./whisperx_batch.log"
IGNORE_FILE="$DATA/ignore_list.json"

THREADS=$(nproc)

mkdir -p "$DATA/ref"

echo "==== WhisperX Batch Start ====" | tee -a "$LOG"
echo "Using $THREADS threads" | tee -a "$LOG"

##############################################
# Ctrl+C safe stop
##############################################
trap "echo 'Stopping…'; exit 1" SIGINT

##############################################
# Load SyncOrbit CSV (minimal, robust)
##############################################
declare -A DECISION

if [[ -f "$SYNCORBIT_CSV" ]]; then
    echo "[INFO] Loading SyncOrbit CSV…" | tee -a "$LOG"

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue

        # Extract movie title (handles quotes + commas)
        if [[ "$line" =~ ^\"([^\"]+)\"\,(.+) ]]; then
            movie="${BASH_REMATCH[1]}"
            rest="${BASH_REMATCH[2]}"
        else
            movie="${line%%,*}"
            rest="${line#*,}"
        fi

        decision="${rest##*,}"

        # Normalize
        # Trim whitespace safely (no xargs, no eval)
        trim() {
            local var="$1"
            # remove leading/trailing whitespace WITHOUT touching quotes or apostrophes
            var="${var#"${var%%[![:space:]]*}"}"   # leading
            var="${var%"${var##*[![:space:]]}"}"   # trailing
            echo "$var"
        }

        movie_clean=$(trim "$(echo "$movie" | tr -d '\r')")

        decision_clean=$(trim "$(echo "$decision" | tr -d '\r"')")

        # Normalize case
        decision_clean=$(echo "$decision_clean" | tr '[:upper:]' '[:lower:]')

        DECISION["$movie_clean"]="$decision_clean"
    done < "$SYNCORBIT_CSV"
else
    echo "[WARN] No SyncOrbit summary file found!" | tee -a "$LOG"
fi

##############################################
# Load ignore list
##############################################

ignored_movies=()
if [ -f "$IGNORE_FILE" ]; then
      # Remove JSON brackets and quotes → convert to simple list
      mapfile -t ignored_movies < <(jq -r '.[]' "$IGNORE_FILE")
          fi

# Helper to check ignore list
is_ignored() {
    local name="$1"
    for m in "${ignored_movies[@]}"; do
        if [[ "$m" == "$name" ]]; then
            return 0
        fi
    done
    return 1
}

##############################################
# Fuzzy decision lookup
##############################################
fuzzy_decision() {
    local folder="$1"

    for key in "${!DECISION[@]}"; do
        if [[ "$folder" == "$key" ]] || [[ "$folder" == *"$key"* ]]; then
            echo "${DECISION[$key]}"
            return
        fi
    done

    echo ""   # unknown
}

##############################################
# Check if Finnish sub exists
##############################################

has_finnish_sub() {
    local DIR="$1"
    shopt -s nullglob
    local files=( "$DIR"/*.fi.srt "$DIR"/*.FI.srt "$DIR"/*.fin.srt "$DIR"/*.FIN.srt )
    shopt -u nullglob

    if (( ${#files[@]} > 0 )); then
        return 0
    else
        return 1
    fi
}

##############################################
# Detect language from ffprobe metadata
##############################################
detect_language_metadata() {
    local VIDEO="$1"

    local lang=$(ffprobe -v quiet -select_streams a:0 \
        -show_entries stream_tags=language \
        -of default=nw=1:nk=1 "$VIDEO" 2>/dev/null)

    [[ -z "$lang" ]] && lang="en"
    echo "$lang"
}

map_lang() {
    local code="$1"

    # normalize case
    code=$(echo "$code" | tr '[:upper:]' '[:lower:]')

    case "$code" in
        # English-family
        eng|ena|en) echo "en" ;;
        fre|fra|fr) echo "fr" ;;
        ger|deu|ge|de) echo "de" ;;
        ita|it) echo "it" ;;
        spa|es) echo "es" ;;
        swe|sv) echo "sv" ;;
        nor|no|nob|nno) echo "no" ;;
        dut|nld|hol|ho|ndl|du) echo "nl" ;;
        fin|fi) echo "fi" ;;

        # Common rest
        por|pt) echo "pt" ;;
        rus|ru) echo "ru" ;;
        est|et) echo "et" ;;
        lav|lv) echo "lv" ;;
        lit|lt) echo "lt" ;;
        jpn|ja) echo "ja" ;;
        zho|chi|zh) echo "zh" ;;
        ara|ar) echo "ar" ;;
        pol|pl) echo "pl" ;;
        cze|ces|cz|cs) echo "cs" ;;
        hun|hu) echo "hu" ;;
        dan|da) echo "da" ;;
        ice|isl|is) echo "is" ;;
        gre|ell|el) echo "el" ;;
        # Fallback
        *) echo "en" ;;   # Default to English
    esac
}

##############################################
# Main loop (stable version)
##############################################
for MOVIE_DIR in "$MOVIES"/*; do
    [[ -d "$MOVIE_DIR" ]] || continue

    MOVIE_NAME=$(basename "$MOVIE_DIR")
    echo -e "\n--- $MOVIE_NAME ---" | tee -a "$LOG"

    # Find a video file
    VIDEO=$(ls "$MOVIE_DIR"/*.{mp4,mkv,avi,mov} 2>/dev/null | head -n 1)
    if [[ -z "$VIDEO" ]]; then
        echo "[SKIP] No video" | tee -a "$LOG"
        continue
    fi

    # Skip if no Finnish sub exists
    if ! has_finnish_sub "$MOVIE_DIR"; then
        echo "[SKIP] No Finnish subtitle" | tee -a "$LOG"
        continue
    fi

    DEST="$DATA/ref/$MOVIE_NAME"
    REF_SRT="$DEST/ref.srt"

    # Skip if reference exists
    if [[ -f "$REF_SRT" ]]; then
        echo "[SKIP] Already has Whisper reference" | tee -a "$LOG"
        continue
    fi

    # Skip if ignored
    if is_ignored "$MOVIE_NAME"; then
        echo "[SKIP] Ignored movie: $MOVIE_NAME" | tee -a "$LOG"
        continue
    fi

    # Decision from SyncOrbit
    DEC=$(fuzzy_decision "$MOVIE_NAME")
    echo "[DEBUG] decision = '$DEC'"

    # *** OPTION B: Skip only synced ***
    if [[ "$DEC" == "synced" ]]; then
        echo "[SKIP] Synced in SyncOrbit" | tee -a "$LOG"
        continue
    fi

    # Detect spoken language
    RAW_LANG=$(detect_language_metadata "$VIDEO")
    LANGUAGE=$(map_lang "$RAW_LANG")
    echo "[LANG] ffprobe=$RAW_LANG → using=$LANGUAGE"

    mkdir -p "$DEST"

    # Extract audio
    AUDIO="/tmp/ref_audio.wav"
    rm -f "$AUDIO"

    ffmpeg -y -i "$VIDEO" -vn -ac 1 -ar 16000 "$AUDIO" >>"$LOG" 2>&1
    if [[ ! -f "$AUDIO" ]]; then
        echo "[ERROR] ffmpeg audio extract failed" | tee -a "$LOG"
        continue
    fi

    # Run WhisperX
    whisperx "$AUDIO" \
        --model medium \
        --vad_method silero \
        --device cpu \
        --threads "$THREADS" \
        --compute_type int8 \
        --language "$LANGUAGE" \
        --output_dir "$DEST" \
        --output_format srt \
        --print_progress True \
        >>"$LOG" 2>&1

    # Whisper output location
    GENERATED="$DEST/$(basename "$AUDIO" .wav).srt"

    if [[ -f "$GENERATED" ]]; then
        mv "$GENERATED" "$REF_SRT"
        echo "[DONE] Created ref.srt" | tee -a "$LOG"
    else
        echo "[ERROR] WhisperX failed" | tee -a "$LOG"
    fi

done

echo "=== Batch Complete ==="

