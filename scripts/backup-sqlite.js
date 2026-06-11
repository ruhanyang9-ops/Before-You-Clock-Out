const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "..");
loadEnvFile(path.join(root, ".env"));

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const backupDir = path.join(root, "backups");
const keepDays = Number(process.env.BACKUP_KEEP_DAYS || 14);

const sqliteFiles = collectSqliteFiles(dataDir);
if (!sqliteFiles.length) {
  console.error(`未找到 SQLite 文件：${dataDir}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetDir = path.join(backupDir, `snapshot-${stamp}`);
fs.mkdirSync(targetDir, { recursive: true });

sqliteFiles.forEach((source) => {
  checkpoint(source);
  const relative = path.relative(dataDir, source);
  const target = path.join(targetDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
});

const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
for (const file of fs.readdirSync(backupDir)) {
  const fullPath = path.join(backupDir, file);
  const stat = fs.statSync(fullPath);
  const isManagedBackup = /^snapshot-/.test(file) || /^app-.*\.sqlite$/.test(file);
  if (isManagedBackup && stat.mtimeMs < cutoff) fs.rmSync(fullPath, { recursive: true, force: true });
}

console.log(`SQLite 备份已生成：${targetDir}`);
console.log(`备份文件数：${sqliteFiles.length}`);

function collectSqliteFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSqliteFiles(fullPath);
    return entry.isFile() && /\.sqlite$/.test(entry.name) ? [fullPath] : [];
  });
}

function checkpoint(file) {
  try {
    const database = new DatabaseSync(file);
    database.exec("PRAGMA wal_checkpoint(FULL)");
    database.close();
  } catch (error) {
    console.warn(`跳过 WAL checkpoint：${file} (${error.message})`);
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  fs.readFileSync(filePath, "utf8").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) return;
    process.env[match[1]] = parseEnvValue(match[2]);
  });
}

function parseEnvValue(value) {
  let output = String(value || "").trim();
  const commentIndex = output.search(/\s#/);
  if (commentIndex >= 0) output = output.slice(0, commentIndex).trim();
  if ((output.startsWith('"') && output.endsWith('"')) || (output.startsWith("'") && output.endsWith("'"))) {
    output = output.slice(1, -1);
  }
  return output.replace(/\\n/g, "\n");
}
