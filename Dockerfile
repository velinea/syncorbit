############################################################
# Base image with all system dependencies
############################################################
FROM python:3.10-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    pkg-config \
    git \
    curl \
    wget \
    vim \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs


############################################################
# Build Whisper.cpp (modern CMake version)
############################################################
FROM base AS whisper

WORKDIR /app/whisper

# Clone latest whisper.cpp
RUN git clone --depth=1 https://github.com/ggerganov/whisper.cpp .

# Build with CMake
RUN mkdir build && cd build && cmake .. && make -j4

# Download multilingual 500MB model (good balance)
RUN wget -q https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
    -O ggml-small.bin



############################################################
# Final runtime image
############################################################
FROM base AS runtime

WORKDIR /app

# Copy Whisper executable (THIS is the correct path)
COPY --from=whisper /app/whisper/build/bin/whisper /usr/local/bin/whisper-main

# Copy the model
COPY --from=whisper /app/whisper/ggml-small.bin /app/whisper/ggml-small.bin

# Install Python dependencies
COPY python/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Install Node dependencies
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Limit CPU usage for PyTorch/BLAS
ENV OMP_NUM_THREADS=1
ENV OPENBLAS_NUM_THREADS=1
ENV MKL_NUM_THREADS=1
ENV NUMEXPR_NUM_THREADS=1

EXPOSE 5010
CMD ["node", "server.js"]
