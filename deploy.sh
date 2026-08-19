#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Copying .env if missing"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit MEDIA_PATH / DATA_PATH first."
fi

echo "==> Building image"
docker compose build

echo "==> Recreating container"
docker compose up -d --remove-orphans

echo "==> Done"