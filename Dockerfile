# ============================
# Stage 1 — Install Node deps
# ============================
FROM node:20-slim AS build

WORKDIR /app

# Install only prod dependencies for node
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build frontend if you have one (optional)
# COPY . .
# RUN npm run build

# ============================
# Stage 2 — Final Runtime
# ============================
FROM node:20-slim

WORKDIR /app

# Install minimal Python runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv python3-setuptools vim \
    && rm -rf /var/lib/apt/lists/*

# Create small virtual env for python tools
RUN python3 -m venv /app/.venv
ENV PATH="/app/.venv/bin:${PATH}"

# Copy Python alignment scripts
COPY python/ /app/python/

# Install only required Python packages
COPY python/requirements.txt /app/python/
RUN pip install --no-cache-dir -r /app/python/requirements.txt

# Copy Node runtime
COPY --from=build /app/node_modules /app/node_modules
COPY . .

# Expose runtime port
EXPOSE 5010

# Create persistent storage for:
#   - syncorbit_library_summary.csv
#   - *.syncinfo
VOLUME ["/app/data"]

ENV SYNCORBIT_DATA="/app/data"

CMD ["node", "server.js"]
