# Example: Node Express + Prisma + PostgreSQL

## Detection

- Backend entry: `server.js` or `src/server.ts`
- Scripts: `build`, `start`, maybe `prisma`
- Database: `prisma/schema.prisma`
- Required env: `DATABASE_URL`, `PORT`, `JWT_SECRET`

## ECS Commands

```bash
cd /opt/my-express-app
cp .env.production.example .env
npm install
npm run build
npx prisma generate
npx prisma migrate deploy
pm2 startOrReload ecosystem.config.js --env production
pm2 save
sudo nginx -t
sudo systemctl reload nginx
```

## DATABASE_URL

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public
```

Use Aliyun RDS whitelist/security group rules to allow the ECS private IP. Do not expose PostgreSQL to the public internet.
