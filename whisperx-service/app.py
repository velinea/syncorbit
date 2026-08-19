from fastapi import FastAPI
from pydantic import BaseModel
import os
import subprocess
import shlex
import logging
import time
import traceback
from pathlib import Path

# -----------------------------
# Config
# -----------------------------
DEVICE = "cpu"
COMPUTE_TYPE = "int8"
VAD_METHOD = "silero"

# -----------------------------
# App & state
# -----------------------------
app = FastAPI(title="WhisperX Service")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("whisperx-service")


# -----------------------------
# Models
# -----------------------------
class TranscribeRequest(BaseModel):
    video_path: str
    output_path: str
    language: str | None = "en"


# -----------------------------
# API
# -----------------------------
@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    """
    Transcribe a video and write a Whisper reference SRT.

    Synchronous: the caller (SyncOrbit) waits for the result. WhisperX names
    the SRT after the media, so we normalize it to ref.srt afterwards.
    """
    try:
        video = Path(req.video_path)
        out = Path(req.output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        language = req.language or "en"

        cmd = [
            "whisperx",
            str(video),
            "--model",
            "small",
            "--device",
            DEVICE,
            "--compute_type",
            COMPUTE_TYPE,
            "--vad_method",
            VAD_METHOD,
            "--language",
            language,
            "--output_format",
            "srt",
            "--output_dir",
            str(out.parent),
        ]

        log.info("Running WhisperX CLI:")
        log.info(" ".join(shlex.quote(c) for c in cmd))

        start = time.time()
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
        )

        if proc.returncode != 0:
            log.error(proc.stderr)
            return {"ok": False, "error": proc.stderr.strip()}

        log.info(proc.stdout)

        ref_dir = Path(out.parent)  # this must already exist
        srt_files = list(ref_dir.glob("*.srt"))

        if not srt_files:
            raise RuntimeError("WhisperX produced no SRT output")

        # WhisperX names the file after the media (e.g. Movie Name.srt)
        generated_srt = srt_files[0]
        final_ref = ref_dir / "ref.srt"

        # Replace / normalize
        generated_srt.replace(final_ref)

        log.info(
            "Whisper reference normalized: %s → %s", generated_srt.name, final_ref.name
        )
        log.info(f"Done in {time.time() - start:.1f}s")
        return {"ok": True}

    except Exception:
        log.error(traceback.format_exc())
        return {"ok": False, "error": "internal_error"}


@app.get("/health")
def health():
    return {"ok": True}