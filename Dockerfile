###############################################
# 1. Base — Python + Node minimal
###############################################
FROM python:3.11-slim AS base

# Avoid Python writing .pyc
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Create app directory
WORKDIR /app

# System dependencies (very lightweight)
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm ffmpeg git \
    && apt-get clean && rm -rf /var/lib/apt/lists/*


###############################################
# 2. Install Python dependencies
###############################################
COPY python/requirements.txt /app/python/requirements.txt

# requirements.txt MUST be torch-free:
# Example:
#   fastembed
#   rapidfuzz
#   numpy
#   scipy
#   scikit-learn
#   python-dotenv
#   flask (if needed by python server)
#
# No torch, no transformers, no whisper.

RUN pip install --no-cache-dir -r /app/python/requirements.txt


###############################################
# 3. Install Node dependencies
###############################################
COPY package.json package-lock.json /app/

RUN npm install --omit=dev


###############################################
# 4. Copy Application Files
###############################################
COPY server.js /app/server.js
COPY public /app/public
COPY python /app/python

###############################################
# 5. Create required folders
###############################################
RUN mkdir -p /app/media /app/data

###############################################
# 6. Expose server
###############################################
EXPOSE 5010

###############################################
# 7. Start SyncOrbit server
###############################################
CMD ["node", "server.js"]
