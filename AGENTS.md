# Agent Instructions

This repository includes deployment assets for Aliyun ECS and a reusable Codex skill under `.codex/skills/aliyun-fullstack-deploy`.

## Deployment File Rules

1. Before modifying deployment-related files, inspect the project structure, package scripts, runtime entry, environment variables, database layer, and current Git status.
2. Do not delete or rewrite business features while working on deployment files.
3. Never commit real `.env` files, API keys, tokens, passwords, private keys, database files, backup archives, or full production database URLs with credentials.
4. Keep deployment scripts readable, conservative, and reusable. Prefer explicit echo steps and fail fast with `set -euo pipefail`.
5. Deployment documentation must be understandable to non-specialists and include exact commands where possible.
6. After deployment-related edits, output:
   - New or modified file list.
   - Production environment variable checklist.
   - Aliyun deployment steps.
   - Manual actions the user still needs to complete.

## Safety Defaults

- Do not remove `data/`, `logs/`, `backups/`, uploads, or `.env` during deploy or rollback.
- Use `COOKIE_SECURE=false` for temporary HTTP/IP testing and `COOKIE_SECURE=true` only after HTTPS is live.
- Keep app ports bound to `127.0.0.1` behind Nginx unless the user explicitly asks for public direct access.
- Run validation such as `npm run check`, `node --check`, `pm2 status`, `sudo nginx -t`, and `/api/health` when available.
