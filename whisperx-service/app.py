from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel
import whisperx
import uuid
import os
import threading
from pathlib import Path
import logging
import time

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

jobs = {}  # job_id -> status dict
job_queue = []
queue_lock = threading.Lock()
worker_running = False

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("whisperx-service")

# -----------------------------
# Load model ONCE
# -----------------------------
print("Loading WhisperX model...")
model = whisperx.load_model(
    "small",
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    vad_method=VAD_METHOD,
)
print("WhisperX model loaded")


# -----------------------------
# Models
# -----------------------------
class TranscribeRequest(BaseModel):
    video_path: str
    output_path: str
    language: str | None = "en"


# -----------------------------
# Worker
# -----------------------------
def worker_loop():
    global worker_running

    while True:
        with queue_lock:
            if not job_queue:
                worker_running = False
                return
            job_id = job_queue.pop(0)

        job = jobs[job_id]
        job["state"] = "running"
        job["progress"] = 0.1

        try:
            video = job["video_path"]
            out_srt = job["output_path"]

            os.makedirs(os.path.dirname(out_srt), exist_ok=True)

            job["message"] = "Transcribing audio"
            result = model.transcribe(video, language=job["language"])
            job["progress"] = 0.7

            job["message"] = "Writing SRT"
            whisperx.utils.write_srt(result["segments"], out_srt)

            job["state"] = "done"
            job["progress"] = 1.0
            job["message"] = "Completed"

        except Exception as e:
            job["state"] = "error"
            job["message"] = str(e)

        time.sleep(0.2)


def start_worker_if_needed():
    global worker_running
    with queue_lock:
        if worker_running:
            return
        worker_running = True

    thread = threading.Thread(target=worker_loop, daemon=True)
    thread.start()


# -----------------------------
# API
# -----------------------------
import subprocess
import shlex


@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    import traceback

    try:
        video = Path(req.video_path)
        out = Path(req.output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        cmd = [
            "whisperx",
            str(video),
            "--model",
            "small",
            "--device",
            "cpu",
            "--compute_type",
            "int8",
            "--vad_method",
            "silero",
            "--language",
            "en",
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

        out_dir = Path(output_path)
        srt_files = list(out_dir.glob("*.srt"))

        if not srt_files:
            raise RuntimeError("WhisperX produced no SRT output")

        # Take the first (there should be exactly one)
        generated = srt_files[0]
        ref_path = out_dir / "ref.srt"

        # Replace existing ref.srt atomically
        generated.replace(ref_path)

        log.info("Whisper reference normalized: %s → %s", generated.name, ref_path.name)
        log.info(f"Done in {time.time() - start:.1f}s")
        return {"ok": True}

    except Exception:
        log.error(traceback.format_exc())
        return {"ok": False, "error": "internal_error"}


@app.get("/status/{job_id}")
def status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    return {
        "state": job["state"],
        "progress": job["progress"],
        "message": job["message"],
    }


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": True}
