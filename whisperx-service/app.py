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


def write_srt(segments, out_path):
    def fmt(ts):
        h = int(ts // 3600)
        m = int((ts % 3600) // 60)
        s = int(ts % 60)
        ms = int((ts - int(ts)) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    with open(out_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n")
            f.write(f"{fmt(seg['start'])} --> {fmt(seg['end'])}\n")
            f.write(seg["text"].strip() + "\n\n")


# -----------------------------
# API
# -----------------------------
@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    start = time.time()

    video = Path(req.video_path)
    out = Path(req.output_path)

    log.info(f"Transcribe request")
    log.info(f"  video: {video}")
    log.info(f"  output: {out}")
    log.info(f"  language: {req.language}")

    if not video.exists():
        return {"ok": False, "error": "video_not_found"}

    out.parent.mkdir(parents=True, exist_ok=True)

    log.info("Loading WhisperX model…")

    model = whisperx.load_model(
        "small",
        device="cpu",
        compute_type="int8",
        vad_method=VAD_METHOD,
        language=req.language,  # 👈 FORCE LANGUAGE
    )

    log.info("Model loaded, starting transcription…")

    result = model.transcribe(str(video))

    log.info("Transcription finished, writing SRT…")

    write_srt(result["segments"], out)

    log.info(f"Done in {time.time() - start:.1f}s, wrote {out}")

    return {
        "ok": True,
        "segments": len(result["segments"]),
        "elapsed_sec": round(time.time() - start, 1),
    }


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
