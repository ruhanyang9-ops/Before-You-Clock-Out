# Pre-Deploy Checklist

- [ ] Confirm architecture: monolith, frontend/backend split, Next.js, API-only, or Docker.
- [ ] Confirm package manager and lockfile.
- [ ] Confirm Node.js version requirement.
- [ ] Confirm `build`, `start`, `check`, `test`, and migration commands.
- [ ] Confirm app port and that backend reads `process.env.PORT`.
- [ ] Confirm frontend API base URL works in production.
- [ ] Confirm `.env.production.example` exists and contains no real secrets.
- [ ] Confirm `.gitignore` excludes `.env`, `node_modules`, build output, database files, logs, uploads, and backups.
- [ ] Confirm database type and location: RDS, ECS local, Supabase, MongoDB Atlas, SQLite, or other.
- [ ] Confirm database migration plan and backup plan.
- [ ] Confirm Aliyun ECS OS, public IP, SSH user, and deployment directory.
- [ ] Confirm security group opens 22, 80, 443 and keeps app/database ports private unless needed.
- [ ] Confirm domain DNS ownership and target A records.
- [ ] Confirm HTTPS plan and cookie `Secure` behavior.
