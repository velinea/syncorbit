FROM python:3.10-slim AS python-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    cmake \
    wget \
    curl \
    git \
    vim \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

FROM python-base AS whisper
WORKDIR /app/whisper

# Clone whisper.cpp
RUN git clone --depth=1 https://github.com/ggerganov/whisper.cpp .

# Build modern whisper.cpp (uses CMake)
RUN mkdir build && cd build && cmake .. && make -j4

# Download multilingual model
RUN wget -q https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
    -O ggml-small.bin

# Production/runtime
FROM python-base AS runtime
WORKDIR /app

COPY --from=whisper /app/whisper/main /usr/local/bin/whisper-main
COPY --from=whisper /app/whisper/ggml-small.bin /app/whisper/

COPY python/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

ENV OMP_NUM_THREADS=1
ENV OPENBLAS_NUM_THREADS=1
ENV MKL_NUM_THREADS=1

EXPOSE 5010

CMD ["node", "server.js"]
