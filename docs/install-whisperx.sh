#!/usr/bin/env bash
set -e

echo "=== Updating system ==="
sudo apt update
sudo apt install -y python3 python3-venv python3-dev ffmpeg wget git build-essential

echo "=== Creating virtual environment ==="
python3 -m venv whisperx-venv
source whisperx-venv/bin/activate

echo "=== Installing CTranslate2 GPU backend ==="
pip install --upgrade pip wheel setuptools
pip install ctranslate2==3.24.0
pip install faster-whisper==1.0.0 --no-deps

echo "=== Installing Silero VAD ==="
pip install git+https://github.com/snakers4/silero-vad.git@master

echo "=== Installing WhisperX WITHOUT PyTorch ==="
pip install whisperx --no-deps

echo "=== Installation complete ==="
echo "Run WhisperX with:"
echo "source whisperx-venv/bin/activate"
echo "whisperx audio.wav --model_dir models --model small.en --device cuda --compute_type float32 --vad_method silero"

