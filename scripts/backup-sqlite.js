const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const dataPath = path.join(root, "data", "app.sqlite");
const backupDir = path.join(root, "backups");
const keepDays = Number(process.env.BACKUP_KEEP_DAYS || 14);

if (!fs.existsSync(dataPath)) {
  console.error(`SQLite 文件不存在：${dataPath}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(backupDir, `app-${stamp}.sqlite`);
fs.copyFileSync(dataPath, target);

const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
for (const file of fs.readdirSync(backupDir)) {
  if (!/^app-.*\.sqlite$/.test(file)) continue;
  const fullPath = path.join(backupDir, file);
  const stat = fs.statSync(fullPath);
  if (stat.mtimeMs < cutoff) fs.rmSync(fullPath);
}

console.log(`SQLite 备份已生成：${target}`);
