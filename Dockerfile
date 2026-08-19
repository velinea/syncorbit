FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# --- System deps for Python + ffmpeg ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-dev ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# --- Python deps (cached until requirements.txt changes) ---
COPY python/requirements.txt ./python/requirements.txt
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir -r python/requirements.txt

# --- Node deps (cached until package*.json changes) ---
COPY package*.json ./
RUN npm ci --only=production

# --- App source (Node + Python) ---
COPY . .

ENV EXECJS_RUNTIME=Node
ENV PATH="/usr/bin:/usr/local/bin:/app/.venv/bin"
ENV SYNCORBIT_DATA="/app/data"

EXPOSE 5010

CMD ["node", "server.cjs"]