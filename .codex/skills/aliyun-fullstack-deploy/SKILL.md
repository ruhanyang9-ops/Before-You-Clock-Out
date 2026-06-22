---
name: aliyun-fullstack-deploy
description: Use when deploying or preparing a full-stack website for Alibaba Cloud ECS with Node.js, Nginx, PM2, database setup, domain DNS, HTTPS, deployment scripts, rollback, or production troubleshooting such as 502, port, database, Nginx, PM2, build, DNS, and SSL failures.
---

# Aliyun Full-Stack Deploy

Use this skill when the user asks to deploy a full-stack site to Alibaba Cloud ECS, configure ECS/Nginx/PM2/database/domain/HTTPS, generate deployment files or docs, or troubleshoot launch failures such as 502 Bad Gateway, API unreachable, database connection failure, closed ports, PM2 crashes, bad builds, DNS failures, or certificate errors.

## First Rules

- Do not change business behavior unless the user explicitly asks.
- Do not delete existing runtime data, uploaded files, databases, backups, or `.env`.
- Do not commit secrets: `.env`, API keys, tokens, passwords, private keys, or full database URLs with credentials.
- Prefer existing project conventions over new tooling.
- Before editing deployment files, inspect project structure and scripts.
- Make every generated command readable and safe for a non-specialist operator.

## Mandatory Pre-Deploy Inspection

Run a lightweight inspection before making files or commands:

```bash
pwd
rg --files -g '!*node_modules*' -g '!data/**' -g '!backups/**'
git status --short --ignored
test -f package.json && sed -n '1,180p' package.json
rg -n "localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|process\\.env|PORT|DATABASE_URL|MYSQL_URL|POSTGRES_URL|MONGO|PRISMA|Sequelize|TypeORM|Mongoose|fetch\\(" -g '!*node_modules*' -g '!data/**' -g '!backups/**'
```

Determine and record:

- Architecture: monolithic full-stack, frontend/backend split, static frontend plus API, Next.js full-stack, Dockerized app, or worker/API only.
- Package manager: npm, pnpm, yarn, or none. Use the lockfile when present.
- Scripts in `package.json`: `dev`, `build`, `start`, `check`, `test`, `migrate`, `prisma`, `seed`.
- Relevant directories: `server`, `api`, `backend`, `frontend`, `client`, `app`, `pages`, `src`, `prisma`, `migrations`, `db`, `database`.
- Runtime entry: `server.js`, `index.js`, `dist/server.js`, Next.js, Express, Fastify, Koa, Nest, or other.
- Whether backend uses `process.env.PORT`; if not, identify how to make the port configurable.
- Whether frontend API base URL is relative or production-configurable; flag hardcoded localhost.
- Environment files: `.env.example`, `.env.production.example`, framework-specific env examples.
- Database variables: `DATABASE_URL`, `MYSQL_URL`, `POSTGRES_URL`, `MONGODB_URI`, `REDIS_URL`, custom variables.
- ORM/database layer: Prisma, Sequelize, TypeORM, Mongoose, Drizzle, Knex, native SQL, SQLite.
- Secret risk: committed `.env`, tokens, keys, connection strings, SQLite files, uploads, backup folders.

## Files To Generate Or Update

Generate or update these when appropriate:

- `ecosystem.config.js`
- `nginx.<app-name>.conf` or a generic `nginx.conf`
- `deploy.sh`
- `.env.production.example`
- `README_DEPLOY_ALIYUN.md`
- `docker-compose.yml` only when Docker is a good fit or the project already uses Docker

Use bundled templates when useful:

- `templates/ecosystem.config.js`
- `templates/nginx.conf`
- `templates/deploy.sh`
- `templates/env.production.example`
- `templates/docker-compose.yml`

Keep templates generic and replace placeholders such as `{{APP_NAME}}`, `{{APP_DIR}}`, `{{DOMAIN}}`, `{{PORT}}`, `{{PACKAGE_MANAGER}}`, `{{BUILD_COMMAND}}`, `{{START_COMMAND}}`, and `{{MIGRATE_COMMAND}}`.

## Standard Aliyun ECS Flow

1. Prepare ECS: Ubuntu 22.04/24.04, enough CPU/RAM/disk, and a non-root or root SSH path.
2. Configure Alibaba Cloud security group: open 22, 80, 443; do not expose app port unless the user explicitly needs direct access.
3. Install system packages:

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git nginx
```

4. Install Node.js 24+ when the project requires modern Node or `node:sqlite`:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

5. Install PM2:

```bash
sudo npm install -g pm2
pm2 -v
```

6. Clone or update the repository under `/opt/<app-name>`.
7. Create `.env` from `.env.production.example` on the server; never commit it.
8. Install dependencies:

```bash
npm install
# or
pnpm install --frozen-lockfile
```

9. Build if needed:

```bash
npm run build
```

10. Initialize database or run migrations.
11. Start or reload with PM2:

```bash
pm2 startOrReload ecosystem.config.js --env production
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME"
```

12. Configure Nginx reverse proxy to `127.0.0.1:<app-port>`.
13. Point domain DNS A record to ECS public IP.
14. Configure HTTPS after DNS is live:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com -d www.example.com
sudo certbot renew --dry-run
```

15. Verify website, API, database writes, logs, and mobile access.

## Command Templates

Use the package manager detected from lockfiles:

```bash
npm install
npm run build
npm run start
pm2 start ecosystem.config.js --env production
pm2 save
sudo nginx -t
sudo systemctl reload nginx
```

For pnpm:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run start
```

## Database Handling

Never write production database passwords into GitHub. Put them only in the server `.env`.

Prisma:

```bash
npx prisma generate
npx prisma migrate deploy
```

SQL file import:

```bash
mysql -u <user> -p <database> < ./migrations/init.sql
psql "$DATABASE_URL" -f ./migrations/init.sql
```

Common URL formats:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public
DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/DBNAME
MONGODB_URI=mongodb://USER:PASSWORD@HOST:27017/DBNAME
```

SQLite:

- Keep database files in a persistent directory such as `/opt/<app-name>/data`.
- Ignore `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `data/`, and `backups/`.
- Back up before deploying changes that touch schema or data.

## Security Requirements

- `.env.production.example` may contain variable names and safe placeholders only.
- `deploy.sh` must not contain real secrets.
- Nginx should expose only 80/443 publicly; backend ports stay on `127.0.0.1`.
- Enable HTTPS before setting cookies to `Secure=true`.
- Remind the user to configure Alibaba Cloud security groups, OS firewall, DNS, SSL, and backups.
- If the user pasted a token/key in chat, advise rotating it after the operation.

## Troubleshooting

502 Bad Gateway:

```bash
pm2 status
pm2 logs <app-name>
sudo ss -ltnp | grep <port>
curl http://127.0.0.1:<port>/api/health
sudo nginx -t
sudo tail -n 80 /var/log/nginx/error.log
```

Port not listening:

- Confirm `PORT` in `.env` and `ecosystem.config.js`.
- Confirm the app reads `process.env.PORT`.
- Restart PM2 with `--update-env`.

Database connection failure:

- Confirm `.env` exists on the server.
- Confirm host, port, user, password, database name, SSL mode, and security group allow access.
- Run ORM migrations/generation.
- For RDS, verify whitelist/security group.

Build failure:

- Confirm Node version and package manager.
- Remove stale `node_modules` only if safe.
- Re-run install with the lockfile method.

Nginx config error:

```bash
sudo nginx -t
sudo nginx -T | grep -n "server_name\\|proxy_pass\\|listen"
```

PM2 crash:

```bash
pm2 status
pm2 logs <app-name> --lines 100
pm2 restart <app-name> --update-env
```

DNS not effective:

```bash
dig +short example.com
curl -H "Host: example.com" http://<server-ip>/
```

HTTPS error:

```bash
sudo certbot certificates
sudo certbot renew --dry-run
sudo nginx -t
```

## Rollback

Before rollback, back up databases and uploads.

```bash
cd /opt/<app-name>
git log --oneline -5
git checkout <previous-commit>
npm install
npm run build
pm2 restart <app-name> --update-env
sudo nginx -t && sudo systemctl reload nginx
```

If a database migration is not reversible, restore from backup or run a verified down migration. Keep a `backups/` directory and avoid deleting production data during rollback.

## Final Response Checklist

After using this skill, report:

- New or modified files.
- Production environment variable checklist.
- Aliyun deployment steps and exact commands.
- Manual actions the user must complete, such as DNS, security group, `.env` secrets, RDS whitelist, or HTTPS certificate issuance.
- Validation performed and remaining risks.
