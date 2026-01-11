FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# PyTorch stack (match WhisperX expectations)
RUN pip install --no-cache-dir \
    torch==2.8.0 \
    torchaudio==2.8.0 \
    torchvision==0.23.0

# Core deps WhisperX actually uses
RUN pip install --no-cache-dir \
    "numpy>=2.0.2,<2.1" \
    "transformers>=4.48.0" \
    faster-whisper \
    ctranslate2 \
    "av<16" \
    nltk \
    "pandas>=2.2,<2.3" \
    triton>=3.3.0

# WhisperX itself
RUN pip install --no-cache-dir whisperx==3.7.4

RUN pip install --no-cache-dir fastapi uvicorn

COPY app.py /app/app.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
