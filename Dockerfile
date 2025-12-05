# ============================
# Stage 1 — Node dependencies
# ============================
FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ============================
# Stage 2 — Final Runtime
# ============================
FROM node:20-slim

WORKDIR /app

# ----------------------------
# Install minimal Python
# ----------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv python3-setuptools python3-dev \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------
# Create isolated Python venv
# ----------------------------
RUN python3 -m venv /app/.venv && \
    /app/.venv/bin/python -m pip install --upgrade pip setuptools wheel

# Make the venv the default Python
ENV PATH="/app/.venv/bin:${PATH}"

# ----------------------------
# Copy Node dependencies & project files
# ----------------------------
COPY --from=build /app/node_modules /app/node_modules
COPY . .

# ----------------------------
# Install Python requirements inside venv
# ----------------------------
RUN /app/.venv/bin/pip install --no-cache-dir -r python/requirements.txt

# ----------------------------
# Runtime settings
# ----------------------------
EXPOSE 5010

# Persistent storage:
# /app/data — summary CSV, syncinfo files
VOLUME ["/app/data"]

ENV SYNCORBIT_DATA="/app/data"

# ----------------------------
# Start SyncOrbit Node server
# ----------------------------
CMD ["node", "server.js"]
