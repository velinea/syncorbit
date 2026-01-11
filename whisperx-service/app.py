from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel
import whisperx
import uuid
import os
import threading
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
    language: str | None = None


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
@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    if not os.path.exists(req.video_path):
        raise HTTPException(status_code=400, detail="video_path does not exist")

    job_id = uuid.uuid4().hex

    jobs[job_id] = {
        "state": "queued",
        "progress": 0.0,
        "message": "Queued",
        "video_path": req.video_path,
        "output_path": req.output_path,
        "language": req.language,
        "created": time.time(),
    }

    with queue_lock:
        job_queue.append(job_id)

    start_worker_if_needed()

    return {"job_id": job_id}


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
