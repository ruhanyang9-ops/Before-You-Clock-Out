# Rollback Checklist

- [ ] Identify last known good commit or release tag.
- [ ] Back up current database, uploads, and `.env` before rollback.
- [ ] Confirm whether recent database migrations are reversible.
- [ ] Stop traffic or announce maintenance window if needed.
- [ ] Run `git checkout <previous-commit>` or restore the previous release artifact.
- [ ] Reinstall dependencies if lockfile changed.
- [ ] Rebuild the application.
- [ ] Restore database backup or run verified down migration if required.
- [ ] Restart PM2 with `--update-env`.
- [ ] Test local app port and Nginx route.
- [ ] Verify login, primary API, and database writes.
- [ ] Keep failed release artifacts/logs for diagnosis.
