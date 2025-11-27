# ============================
# Stage 1: build whisper.cpp
# ============================
FROM node:20-slim AS whisper-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    wget \
    libgomp1 \
    ca-certificates \
    && update-ca-certificates \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/whisper

# Clone whisper.cpp
# Huom: Branch master on yleensä turvallisin, mutta varmista yhteensopivuus.
RUN git clone --depth=1 https://github.com/ggerganov/whisper.cpp.git .

# Build with CMake
# TÄRKEÄÄ: -DBUILD_SHARED_LIBS=ON luo .so tiedostot
RUN mkdir build && cd build && \
    cmake -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)"

# Download multilingual small model (~48MB)
WORKDIR /app/whisper
RUN wget -q https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
    -O ggml-small.bin


# ============================
# Stage 2: final runtime image
# ============================
FROM node:20-slim

# Lisätty libgomp1 (OpenMP support), jota whisper.cpp tarvitsee moniajoon
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    libsndfile1 \
    libgomp1 \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Python venv ---
RUN python3 -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

COPY python/requirements.txt python/requirements.txt
RUN pip install --no-cache-dir -r python/requirements.txt

# --- Whisper Libraries & Binary ---
# Kopioidaan nämä ENNEN npm installia, jos joku Node-moduuli yrittää linkittyä niihin asennuksessa.
# Huom: whisper.cpp:n uudemmissa versioissa kirjastot voivat olla suoraan build-kansiossa tai build/src -kansiossa.
# Kopioimme kaikki .so-tiedostot build-kansiosta litistettynä /usr/local/libiin.

COPY --from=whisper-build /app/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /app/whisper/ggml-small.bin /app/whisper-model.bin

# Kopioi kirjastot (libwhisper.so, mahdollisesti libggml.so)
COPY --from=whisper-build /app/whisper/build/libwhisper*.so* /usr/local/lib/
# Jos uudempi versio whisperistä erottelee ggml:n, kopioi myös se:
# COPY --from=whisper-build /app/whisper/build/src/libggml*.so* /usr/local/lib/ || true

# Päivitä linkkerin välimuisti
RUN ldconfig

# --- Node deps & App ---
COPY package*.json ./
# Jos käytät node-ffi:tä tai vastaavaa, varmista että se löytää kirjastot tässä vaiheessa
RUN npm install --omit=dev

COPY . .

# Environment variables
ENV LD_LIBRARY_PATH="/usr/local/lib"
ENV WHISPER_MODEL=/app/whisper-model.bin
ENV OMP_NUM_THREADS=4

EXPOSE 5010
CMD ["node", "server.js"]
