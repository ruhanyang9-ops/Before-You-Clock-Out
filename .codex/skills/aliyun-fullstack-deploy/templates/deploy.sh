#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-{{APP_DIR}}}"
PACKAGE_MANAGER="${PACKAGE_MANAGER:-npm}"
BUILD_COMMAND="${BUILD_COMMAND:-npm run build}"
MIGRATE_COMMAND="${MIGRATE_COMMAND:-}"
PM2_CONFIG="${PM2_CONFIG:-ecosystem.config.js}"
NGINX_CONFIG="${NGINX_CONFIG:-/etc/nginx/sites-available/{{APP_NAME}}.conf}"

cd "$APP_DIR"

echo "==> Pull latest code"
git pull

echo "==> Ensure runtime directories"
mkdir -p logs backups data

echo "==> Install dependencies"
if [ "$PACKAGE_MANAGER" = "pnpm" ]; then
  corepack enable
  pnpm install --frozen-lockfile
elif [ "$PACKAGE_MANAGER" = "yarn" ]; then
  yarn install --frozen-lockfile
else
  npm install
fi

echo "==> Build application"
if [ -n "$BUILD_COMMAND" ]; then
  $BUILD_COMMAND
else
  echo "No build command configured; skipping"
fi

echo "==> Run database migrations"
if [ -n "$MIGRATE_COMMAND" ]; then
  $MIGRATE_COMMAND
else
  echo "No migration command configured; skipping"
fi

echo "==> Start or reload PM2"
pm2 startOrReload "$PM2_CONFIG" --env production
pm2 save

echo "==> Test and reload Nginx"
sudo nginx -t
sudo systemctl reload nginx

echo "==> Deployment completed"
