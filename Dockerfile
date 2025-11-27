# ============================
# Stage 1: build whisper.cpp
# ============================
FROM node:20-slim AS whisper-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    wget \
    vim \
    libsndfile1-dev \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/whisper

# Clone whisper.cpp
RUN git clone --depth=1 https://github.com/ggerganov/whisper.cpp.git .

# Build with CMake
RUN mkdir build && cd build && cmake .. && make -j"$(nproc)"

# Download multilingual small model (~48MB)
WORKDIR /app/whisper
RUN wget -q https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
    -O ggml-small.bin


# ============================
# Stage 2: final runtime image
# ============================
FROM node:20-slim

# System deps for Python + numpy/scipy + rapidfuzz + ffmpeg + whisper runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    build-essential \
    g++ \
    gfortran \
    libatlas-base-dev \
    ffmpeg \
    libsndfile1 \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Python venv (to avoid PEP 668 issues) ---
RUN python3 -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

# Python deps
COPY python/requirements.txt python/requirements.txt
RUN pip install --no-cache-dir -r python/requirements.txt

# Node deps
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

# Whisper binary
COPY --from=whisper-build /app/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli

# Whisper shared libraries
COPY --from=whisper-build /app/whisper/build/lib/ /usr/local/lib/

# Whisper model
COPY --from=whisper-build /app/whisper/ggml-small.bin /app/whisper-model.bin

# Ensure runtime loader can find whisper libs
ENV LD_LIBRARY_PATH="/usr/local/lib:${LD_LIBRARY_PATH}"

ENV WHISPER_MODEL=/app/whisper-model.bin

# (Optional) reduce CPU hogging; tweak as you like
ENV OMP_NUM_THREADS=4

EXPOSE 5010
CMD ["node", "server.js"]
