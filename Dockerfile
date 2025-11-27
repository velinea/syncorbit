###############################
# Stage 1: Build Whisper.cpp
###############################
FROM node:20-slim AS whisper-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    wget \
    libsndfile1-dev \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/whisper

# IMPORTANT: Clone WITH submodules !!
RUN git clone --depth=1 --recursive https://github.com/ggerganov/whisper.cpp.git .

# Build whisper.cpp
RUN mkdir build && cd build && cmake .. && make -j"$(nproc)"

# multilingual model
RUN wget -q https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
    -O ggml-small.bin




###############################
# Stage 2: Final Runtime Image
###############################
FROM node:20-slim

# System deps for Python + numpy/scipy + fastembed + ffmpeg
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

#####################################
# Python virtual environment (PEP668)
#####################################
RUN python3 -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

# Python deps
COPY python/requirements.txt python/requirements.txt
RUN pip install --no-cache-dir -r python/requirements.txt

#########################
# Node dependencies
#########################
COPY package*.json ./
RUN npm install --omit=dev

#########################
# App source
#########################
COPY . .

###########################################
# Copy whisper-cli + *ALL .so libraries*
###########################################
COPY --from=whisper-build /app/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli

# Copy ANY .so file built anywhere in whisper/build
COPY --from=whisper-build /app/whisper/build /usr/local/lib-whisper

RUN find /usr/local/lib-whisper -type f -name "*.so*" -exec cp {} /usr/local/lib/ \; \
    && rm -rf /usr/local/lib-whisper

ENV LD_LIBRARY_PATH="/usr/local/lib"

###########################################
# Whisper model
###########################################
COPY --from=whisper-build /app/whisper/ggml-small.bin /app/whisper-model.bin
ENV WHISPER_MODEL="/app/whisper-model.bin"

# Optional: limit CPU threading
ENV OMP_NUM_THREADS=4

EXPOSE 5010

CMD ["node", "server.js"]
