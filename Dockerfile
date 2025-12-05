FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# --- System deps for Python + build ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-full python3-venv python3-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

# --- Node deps ---
COPY package*.json ./
RUN npm ci --only=production

# --- App source (Node + Python) ---
COPY . .

# --- Python venv + deps ---
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir -r python/requirements.txt

ENV PATH="/app/.venv/bin:${PATH}"
ENV SYNCORBIT_DATA="/app/data"

EXPOSE 5010

CMD ["node", "server.js"]
