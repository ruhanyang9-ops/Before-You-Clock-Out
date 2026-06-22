# Example: Next.js + Node Runtime + PostgreSQL

## Detection

- Frontend/full-stack framework: `next.config.js`, `app/`, `pages/`
- Scripts: `next build`, `next start`
- Required env: `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, public `NEXT_PUBLIC_*`

## PM2

Use `npm run start` after `npm run build`. Set `PORT=3000`.

```bash
npm install
npm run build
npx prisma migrate deploy
pm2 startOrReload ecosystem.config.js --env production
```

## Nginx

Proxy all routes to `127.0.0.1:3000`. Keep `NEXTAUTH_URL=https://example.com` after HTTPS is enabled.

## Notes

- Next.js standalone output may use `.next/standalone/server.js`; detect the project setting before choosing PM2 script.
- Public browser variables must be available during build, not only runtime.
