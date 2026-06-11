#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/afterwork-five-minutes"

cd "$APP_DIR"

echo "==> Pull latest code"
git pull

echo "==> Install dependencies"
npm install

echo "==> Run static checks"
npm run check

echo "==> Ensure runtime directories"
mkdir -p data logs backups

echo "==> Start or reload PM2 app"
pm2 startOrReload ecosystem.config.js --env production

echo "==> Save PM2 process list"
pm2 save

echo "==> Deployment completed"
