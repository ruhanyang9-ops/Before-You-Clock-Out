# Post-Deploy Checklist

- [ ] `node -v` meets project requirement.
- [ ] Dependencies install without errors.
- [ ] Build command succeeds.
- [ ] Database migrations succeed.
- [ ] PM2 app is `online`.
- [ ] PM2 startup is enabled and `pm2 save` has run.
- [ ] App listens on `127.0.0.1:<port>`.
- [ ] `curl http://127.0.0.1:<port>/api/health` or equivalent works.
- [ ] Nginx config passes `sudo nginx -t`.
- [ ] Domain or IP returns the app homepage.
- [ ] Main API endpoint returns expected data through Nginx.
- [ ] Login/session works.
- [ ] Database write/read works.
- [ ] Mobile viewport is usable.
- [ ] HTTPS certificate is issued and auto-renew dry run passes.
- [ ] Production `.env` is not committed.
- [ ] Backup job or manual backup command is documented.
