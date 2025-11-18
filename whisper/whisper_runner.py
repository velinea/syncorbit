#!/usr/bin/env python3
import subprocess
import json
import os
from pathlib import Path

WHISPER_IMAGE = "whisper-cli:latest"

def whisper_available():
    """Check whether Whisper Docker image is available."""
    try:
        out = subprocess.run(
            ["docker", "image", "inspect", WHISPER_IMAGE],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return (out.returncode == 0)
    except:
        return False


def transcribe(video_path, out_srt):
    """Call whisper-cli docker image to produce an SRT."""
    video_path = str(Path(video_path).resolve())
    out_srt = str(Path(out_srt).resolve())

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{video_path}:/data/video:ro",
        "-v", f"{Path(out_srt).parent}:/data/out",
        WHISPER_IMAGE,
        "--model", "/app/models/ggml-small.bin",
        "--file", "/data/video",
        "--output-format", "srt",
        "--output-file", f"/data/out/{Path(out_srt).name}"
    ]

    print("Running Whisper:", " ".join(cmd))

    p = subprocess.Popen(cmd)
    p.wait()

    if p.returncode != 0:
        raise RuntimeError(f"Whisper failed with exit code {p.returncode}")

    return out_srt


if __name__ == "__main__":
    print(json.dumps({"available": whisper_available()}))
