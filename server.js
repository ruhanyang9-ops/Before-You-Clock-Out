const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { DatabaseSync } = require("node:sqlite");
const aiService = require("./aiService");
const speechService = require("./speechService");

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const LEGACY_DB_PATH = path.join(DATA_DIR, "app.sqlite");
const AUTH_DB_PATH = path.join(DATA_DIR, "auth.sqlite");
const USER_DATA_DIR = path.join(DATA_DIR, "users");
const DEFAULT_USER_ID = "user_default";
const SESSION_COOKIE = "afm_session";
const sessions = new Map();
const requestContext = new AsyncLocalStorage();
const userDatabases = new Map();
const db = new Proxy({}, {
  get(_target, prop) {
    const store = requestContext.getStore();
    if (!store?.db) throw new Error("No user database is bound to this request");
    const value = store.db[prop];
    return typeof value === "function" ? value.bind(store.db) : value;
  }
});

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
const authDb = new DatabaseSync(AUTH_DB_PATH);
authDb.exec("PRAGMA foreign_keys = ON");
authDb.exec("PRAGMA journal_mode = WAL");
authDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    passwordHash TEXT NOT NULL,
    passwordSalt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`);

const businessSchema = `
  CREATE TABLE IF NOT EXISTS work_records (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    date TEXT NOT NULL UNIQUE,
    rawInput TEXT NOT NULL DEFAULT '',
    completedItems TEXT NOT NULL DEFAULT '[]',
    ongoingItems TEXT NOT NULL DEFAULT '[]',
    tomorrowTasks TEXT NOT NULL DEFAULT '[]',
    projectProgress TEXT NOT NULL DEFAULT '[]',
    risks TEXT NOT NULL DEFAULT '[]',
    reflections TEXT NOT NULL DEFAULT '[]',
    followUpPeople TEXT NOT NULL DEFAULT '[]',
    relatedProjects TEXT NOT NULL DEFAULT '[]',
    uncategorizedItems TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (status IN ('todo','doing','done')),
    priority TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
    dueDate TEXT,
    relatedProjectId TEXT,
    sourceRecordId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    status TEXT NOT NULL CHECK (status IN ('active','done','paused')),
    startDate TEXT,
    endDate TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    recordId TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(recordId, type)
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL UNIQUE,
    role TEXT,
    workGoals TEXT,
    categoryPreferences TEXT,
    reportAudience TEXT,
    outputStyle TEXT,
    dailyTemplate TEXT,
    weeklyTemplate TEXT,
    keyProjects TEXT,
    keywords TEXT,
    collaborators TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`;

const jsonFields = [
  "completedItems",
  "ongoingItems",
  "tomorrowTasks",
  "projectProgress",
  "risks",
  "reflections",
  "followUpPeople",
  "relatedProjects",
  "uncategorizedItems"
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`下班前五分钟 running at http://${HOST}:${PORT}/`);
  console.log(`Auth database: ${AUTH_DB_PATH}`);
  console.log(`User databases: ${USER_DATA_DIR}`);
});

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  if (method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(res, 200, getAuthStatus(req));
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, getHealthStatus());
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const user = verifyUserLogin(body.email || "", body.password || "");
    if (user) {
      const token = createSession(user.id);
      sendJson(res, 200, { ok: true, authRequired: true, user: publicUser(user) }, {
        "Set-Cookie": buildSessionCookie(token)
      });
      return;
    }
    sendJson(res, 401, { error: "邮箱或密码不正确", authRequired: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/register") {
    const body = await readJson(req);
    const result = createUserAccount(body);
    if (result.error) {
      sendJson(res, result.status || 400, { error: result.error, authRequired: true });
      return;
    }
    const token = createSession(result.user.id);
    sendJson(res, 200, { ok: true, authRequired: true, user: publicUser(result.user) }, {
      "Set-Cookie": buildSessionCookie(token)
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    const token = getCookie(req, SESSION_COOKIE);
    if (token) sessions.delete(token);
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
    });
    return;
  }

  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "请先登录个人账号", authRequired: true });
    return;
  }

  const userDb = getUserDatabase(user.id);
  return requestContext.run({ user, db: userDb }, async () => {
  if (method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, { ...getState(), meta: { isEmpty: isDatabaseEmpty() } });
    return;
  }

  if (method === "GET" && url.pathname === "/api/ai/status") {
    sendJson(res, 200, aiService.getAIStatus());
    return;
  }

  if (method === "POST" && url.pathname === "/api/ai/test") {
    sendJson(res, 200, await aiService.testAIConnection());
    return;
  }

  if (method === "GET" && url.pathname === "/api/speech/status") {
    sendJson(res, 200, speechService.getSpeechStatus());
    return;
  }

  if (method === "POST" && url.pathname === "/api/speech/transcribe") {
    const audio = await readBuffer(req, 25_000_000);
    const result = await speechService.transcribeAudio(audio, req.headers["content-type"] || "audio/webm");
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/import-state") {
    if (!isDatabaseEmpty()) {
      sendJson(res, 409, { error: "Database already has data", ...getState() });
      return;
    }
    const body = await readJson(req);
    importState(body.state || body);
    sendJson(res, 200, getState());
    return;
  }

  if (method === "POST" && url.pathname === "/api/records/parse") {
    const body = await readJson(req);
    const existing = getTodayRecord();
    const result = await aiService.parseWorkRecordWithMeta(body.rawInput || "", getAIContextPreference(), existing);
    sendJson(res, 200, { ...result.record, _meta: result._meta });
    return;
  }

  if (method === "POST" && url.pathname === "/api/text/polish") {
    const body = await readJson(req);
    const result = await aiService.polishVoiceTextWithMeta(body.text || "", getAIContextPreference());
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/records") {
    const body = await readJson(req);
    const record = upsertRecord(body.record || body);
    sendJson(res, 200, { record, state: getState() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/records") {
    sendJson(res, 200, filterRecords({
      date: url.searchParams.get("date") || "",
      keyword: url.searchParams.get("keyword") || "",
      project: url.searchParams.get("project") || ""
    }));
    return;
  }

  if (method === "DELETE" && parts[1] === "records" && parts[2]) {
    deleteRecord(parts[2]);
    sendJson(res, 200, getState());
    return;
  }

  if (method === "POST" && url.pathname === "/api/summaries/generate") {
    const body = await readJson(req);
    const type = normalizeSummaryType(body.type || "weekly");
    const record = type === "weekly" || type === "monthly"
      ? buildPeriodRecord(type, body.date || todayISO())
      : getRecordById(body.recordId);
    if (!record) return sendJson(res, 404, { error: "Record not found" });
    const result = await aiService.generateSummaryWithMeta(record, type, getAIContextPreference());
    sendJson(res, 200, {
      content: result.content,
      recordId: record.id,
      rangeLabel: record.rangeLabel || record.date,
      recordCount: record.recordCount || 1,
      type,
      _meta: result._meta
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/summaries") {
    const body = await readJson(req);
    sendJson(res, 200, { summary: upsertSummary(body.summary || body), state: getState() });
    return;
  }

  if (method === "DELETE" && parts[1] === "summaries" && parts[2]) {
    db.prepare("DELETE FROM summaries WHERE id = ?").run(parts[2]);
    sendJson(res, 200, getState());
    return;
  }

  if (method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJson(req);
    sendJson(res, 200, { task: upsertTask(body.task || body), state: getState() });
    return;
  }

  if (method === "PUT" && parts[1] === "tasks" && parts[2]) {
    const body = await readJson(req);
    sendJson(res, 200, { task: upsertTask({ ...(body.task || body), id: parts[2] }), state: getState() });
    return;
  }

  if (method === "DELETE" && parts[1] === "tasks" && parts[2]) {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(parts[2]);
    sendJson(res, 200, getState());
    return;
  }

  if (method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(req);
    sendJson(res, 200, { project: upsertProject(body.project || body), state: getState() });
    return;
  }

  if (method === "POST" && parts[1] === "projects" && parts[2] && parts[3] === "review") {
    const project = getProjectById(parts[2]);
    if (!project) return sendJson(res, 404, { error: "Project not found" });
    const record = buildProjectReviewRecord(project);
    const result = await aiService.generateSummaryWithMeta(record, "project", getAIContextPreference());
    const summary = upsertSummary({
      recordId: `project_${project.id}`,
      type: "project",
      content: result.content
    });
    sendJson(res, 200, { summary, state: getState(), _meta: result._meta });
    return;
  }

  if (method === "PUT" && parts[1] === "projects" && parts[2]) {
    const body = await readJson(req);
    sendJson(res, 200, { project: upsertProject({ ...(body.project || body), id: parts[2] }), state: getState() });
    return;
  }

  if (method === "DELETE" && parts[1] === "projects" && parts[2]) {
    db.prepare("UPDATE tasks SET relatedProjectId = '' WHERE relatedProjectId = ?").run(parts[2]);
    db.prepare("DELETE FROM summaries WHERE recordId = ?").run(`project_${parts[2]}`);
    db.prepare("DELETE FROM projects WHERE id = ?").run(parts[2]);
    sendJson(res, 200, getState());
    return;
  }

  if (method === "PUT" && url.pathname === "/api/preferences") {
    const body = await readJson(req);
    sendJson(res, 200, { preferences: upsertPreference(body.preferences || body), state: getState() });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
  });
}

function getState() {
  const user = currentUser();
  return {
    user: publicUser(user),
    preferences: getPreference(),
    records: db.prepare("SELECT * FROM work_records ORDER BY date DESC").all().map(recordFromRow),
    tasks: db.prepare("SELECT * FROM tasks ORDER BY dueDate ASC, createdAt DESC").all().map(taskFromRow),
    projects: db.prepare("SELECT * FROM projects ORDER BY createdAt DESC").all().map(projectFromRow),
    summaries: db.prepare("SELECT * FROM summaries ORDER BY updatedAt DESC").all().map(summaryFromRow)
  };
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function isDatabaseEmpty() {
  const tables = ["work_records", "tasks", "projects", "summaries", "user_preferences"];
  return tables.every((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count === 0);
}

function getPreference() {
  const row = db.prepare("SELECT * FROM user_preferences WHERE userId = ?").get(currentUserId());
  if (row) return preferenceFromRow(row);
  const now = nowISO();
  return {
    id: uid("pref"),
    userId: currentUserId(),
    role: "",
    workGoals: "",
    categoryPreferences: "完成事项、项目进展、风险、明日计划",
    reportAudience: "",
    outputStyle: "简洁正式",
    dailyTemplate: "",
    weeklyTemplate: "",
    keyProjects: "",
    keywords: "",
    collaborators: "",
    createdAt: now,
    updatedAt: now
  };
}

function getAIContextPreference() {
  const preference = getPreference();
  const projectNames = db.prepare("SELECT name FROM projects ORDER BY createdAt DESC").all().map((project) => project.name);
  return {
    ...preference,
    keyProjects: unique([preference.keyProjects, ...projectNames].flatMap((item) => String(item || "").split(/[,，\n]/))).join("，")
  };
}

function getTodayRecord() {
  const row = db.prepare("SELECT * FROM work_records WHERE date = ?").get(todayISO());
  return row ? recordFromRow(row) : null;
}

function getRecordById(id) {
  const row = db.prepare("SELECT * FROM work_records WHERE id = ?").get(id);
  return row ? recordFromRow(row) : null;
}

function getProjectById(id) {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? projectFromRow(row) : null;
}

function buildProjectReviewRecord(project) {
  const state = getState();
  const records = state.records.filter((record) => record.relatedProjects.includes(project.name));
  const tasks = state.tasks.filter((task) => task.relatedProjectId === project.id);
  return {
    id: `project_${project.id}`,
    userId: currentUserId(),
    date: project.endDate || todayISO(),
    rawInput: [
      `项目名称：${project.name}`,
      `项目周期：${project.startDate || "未填写"} 至 ${project.endDate || todayISO()}`,
      `项目描述：${project.description || "无"}`
    ].join("\n"),
    completedItems: unique([
      ...records.flatMap((record) => record.completedItems || []),
      ...tasks.filter((task) => task.status === "已完成").map((task) => task.title)
    ]),
    ongoingItems: unique([
      ...records.flatMap((record) => record.ongoingItems || []),
      ...tasks.filter((task) => task.status !== "已完成").map((task) => task.title)
    ]),
    tomorrowTasks: unique(records.flatMap((record) => record.tomorrowTasks || [])),
    projectProgress: unique(records.flatMap((record) => record.projectProgress || [])),
    risks: unique(records.flatMap((record) => record.risks || [])),
    reflections: unique(records.flatMap((record) => record.reflections || [])),
    followUpPeople: unique(records.flatMap((record) => record.followUpPeople || [])),
    relatedProjects: [project.name],
    uncategorizedItems: [],
    createdAt: project.createdAt,
    updatedAt: nowISO(),
    rangeLabel: `${project.startDate || "未填写"} 至 ${project.endDate || todayISO()}`,
    recordCount: records.length
  };
}

function upsertRecord(input) {
  const now = nowISO();
  const existing = input.date ? db.prepare("SELECT * FROM work_records WHERE date = ?").get(input.date) : null;
  const record = {
    id: existing?.id || input.id || uid("record"),
    userId: input.userId || currentUserId(),
    date: input.date || todayISO(),
    rawInput: input.rawInput || "",
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now
  };
  jsonFields.forEach((field) => {
    record[field] = Array.isArray(input[field]) ? input[field] : [];
  });
  ensureRelatedProjects(record.relatedProjects);
  db.prepare(`
    INSERT INTO work_records (
      id, userId, date, rawInput, completedItems, ongoingItems, tomorrowTasks,
      projectProgress, risks, reflections, followUpPeople, relatedProjects,
      uncategorizedItems, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      rawInput = excluded.rawInput,
      completedItems = excluded.completedItems,
      ongoingItems = excluded.ongoingItems,
      tomorrowTasks = excluded.tomorrowTasks,
      projectProgress = excluded.projectProgress,
      risks = excluded.risks,
      reflections = excluded.reflections,
      followUpPeople = excluded.followUpPeople,
      relatedProjects = excluded.relatedProjects,
      uncategorizedItems = excluded.uncategorizedItems,
      updatedAt = excluded.updatedAt
  `).run(
    record.id,
    record.userId,
    record.date,
    record.rawInput,
    ...jsonFields.map((field) => JSON.stringify(record[field])),
    record.createdAt,
    record.updatedAt
  );
  syncTasksFromRecord(record);
  return getRecordById(record.id) || record;
}

function syncTasksFromRecord(record) {
  record.tomorrowTasks.forEach((title) => {
    const existing = db.prepare("SELECT id FROM tasks WHERE sourceRecordId = ? AND title = ?").get(record.id, title);
    if (existing) return;
    upsertTask({
      id: uid("task"),
      userId: currentUserId(),
      title,
      description: "从快速记录自动提取",
      status: "todo",
      priority: inferPriority(title),
      dueDate: tomorrowISO(),
      relatedProjectId: projectIdByName(record.relatedProjects[0]) || "",
      sourceRecordId: record.id
    });
  });
}

function upsertTask(input) {
  const now = nowISO();
  const existing = input.id ? db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.id) : null;
  const task = {
    id: input.id || uid("task"),
    userId: input.userId || currentUserId(),
    title: input.title || "",
    description: input.description || "",
    status: normalizeTaskStatus(input.status || "todo"),
    priority: normalizePriority(input.priority || "medium"),
    dueDate: input.dueDate || "",
    relatedProjectId: input.relatedProjectId || "",
    sourceRecordId: input.sourceRecordId || "",
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now
  };
  db.prepare(`
    INSERT INTO tasks (
      id, userId, title, description, status, priority, dueDate,
      relatedProjectId, sourceRecordId, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      priority = excluded.priority,
      dueDate = excluded.dueDate,
      relatedProjectId = excluded.relatedProjectId,
      sourceRecordId = excluded.sourceRecordId,
      updatedAt = excluded.updatedAt
  `).run(
    task.id,
    task.userId,
    task.title,
    task.description,
    task.status,
    task.priority,
    task.dueDate,
    task.relatedProjectId,
    task.sourceRecordId,
    task.createdAt,
    task.updatedAt
  );
  return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id));
}

function upsertProject(input) {
  const now = nowISO();
  const existing = input.id
    ? db.prepare("SELECT * FROM projects WHERE id = ?").get(input.id)
    : input.name
      ? db.prepare("SELECT * FROM projects WHERE name = ?").get(input.name)
      : null;
  const project = {
    id: existing?.id || input.id || uid("project"),
    userId: input.userId || currentUserId(),
    name: input.name || "",
    description: input.description || "",
    status: normalizeProjectStatus(input.status || "active"),
    startDate: input.startDate || "",
    endDate: input.endDate || "",
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now
  };
  db.prepare(`
    INSERT INTO projects (id, userId, name, description, status, startDate, endDate, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      status = excluded.status,
      startDate = excluded.startDate,
      endDate = excluded.endDate,
      updatedAt = excluded.updatedAt
  `).run(
    project.id,
    project.userId,
    project.name,
    project.description,
    project.status,
    project.startDate,
    project.endDate,
    project.createdAt,
    project.updatedAt
  );
  return projectFromRow(db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id));
}

function upsertSummary(input) {
  const now = nowISO();
  const type = normalizeSummaryType(input.type || "daily");
  const existing = input.recordId
    ? db.prepare("SELECT * FROM summaries WHERE recordId = ? AND type = ?").get(input.recordId, type)
    : null;
  const summary = {
    id: existing?.id || input.id || uid("summary"),
    userId: input.userId || currentUserId(),
    recordId: input.recordId || "",
    type,
    content: input.content || "",
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now
  };
  db.prepare(`
    INSERT INTO summaries (id, userId, recordId, type, content, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(recordId, type) DO UPDATE SET
      content = excluded.content,
      updatedAt = excluded.updatedAt
  `).run(summary.id, summary.userId, summary.recordId, summary.type, summary.content, summary.createdAt, summary.updatedAt);
  return summaryFromRow(db.prepare("SELECT * FROM summaries WHERE recordId = ? AND type = ?").get(summary.recordId, summary.type));
}

function upsertPreference(input) {
  const now = nowISO();
  const existing = db.prepare("SELECT * FROM user_preferences WHERE userId = ?").get(currentUserId());
  const pref = {
    id: existing?.id || input.id || uid("pref"),
    userId: currentUserId(),
    role: input.role || "",
    workGoals: input.workGoals || "",
    categoryPreferences: input.categoryPreferences || "",
    reportAudience: input.reportAudience || "",
    outputStyle: input.outputStyle || "",
    dailyTemplate: input.dailyTemplate || "",
    weeklyTemplate: input.weeklyTemplate || "",
    keyProjects: input.keyProjects || "",
    keywords: input.keywords || "",
    collaborators: input.collaborators || "",
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now
  };
  db.prepare(`
    INSERT INTO user_preferences (
      id, userId, role, workGoals, categoryPreferences, reportAudience,
      outputStyle, dailyTemplate, weeklyTemplate, keyProjects, keywords,
      collaborators, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET
      role = excluded.role,
      workGoals = excluded.workGoals,
      categoryPreferences = excluded.categoryPreferences,
      reportAudience = excluded.reportAudience,
      outputStyle = excluded.outputStyle,
      dailyTemplate = excluded.dailyTemplate,
      weeklyTemplate = excluded.weeklyTemplate,
      keyProjects = excluded.keyProjects,
      keywords = excluded.keywords,
      collaborators = excluded.collaborators,
      updatedAt = excluded.updatedAt
  `).run(
    pref.id,
    pref.userId,
    pref.role,
    pref.workGoals,
    pref.categoryPreferences,
    pref.reportAudience,
    pref.outputStyle,
    pref.dailyTemplate,
    pref.weeklyTemplate,
    pref.keyProjects,
    pref.keywords,
    pref.collaborators,
    pref.createdAt,
    pref.updatedAt
  );
  return getPreference();
}

function importState(input) {
  const state = input || {};
  (state.projects || []).forEach((project) => upsertProject(project));
  upsertPreference(state.preferences || {});
  (state.records || []).forEach((record) => upsertRecord(record));
  (state.tasks || []).forEach((task) => upsertTask(task));
  (state.summaries || []).forEach((summary) => upsertSummary(summary));
}

function filterRecords(filters) {
  return getState().records.filter((record) => {
    const dateOk = !filters.date || record.date === filters.date;
    const keywordOk = !filters.keyword || JSON.stringify(record).includes(filters.keyword);
    const projectOk = !filters.project || filters.project === "全部" || record.relatedProjects.includes(filters.project);
    return dateOk && keywordOk && projectOk;
  });
}

function deleteRecord(id) {
  db.prepare("DELETE FROM summaries WHERE recordId = ?").run(id);
  db.prepare("UPDATE tasks SET sourceRecordId = '' WHERE sourceRecordId = ?").run(id);
  db.prepare("DELETE FROM work_records WHERE id = ?").run(id);
}

function buildPeriodRecord(type, anchorDate = todayISO()) {
  const range = periodRange(type, anchorDate);
  const records = getState().records
    .filter((record) => record.date >= range.start && record.date <= range.end)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!records.length) return null;
  const aggregate = {
    id: `period_${type}_${range.start}_${range.end}`,
    userId: currentUserId(),
    date: range.end,
    rawInput: records.map((record) => `${record.date}：${record.rawInput}`).filter(Boolean).join("\n"),
    createdAt: records[0].createdAt,
    updatedAt: nowISO(),
    rangeLabel: `${range.start} 至 ${range.end}`,
    recordCount: records.length
  };
  jsonFields.forEach((field) => {
    aggregate[field] = unique(records.flatMap((record) => record[field] || []));
  });
  return aggregate;
}

function periodRange(type, anchorDate) {
  const date = new Date(`${anchorDate}T00:00:00`);
  if (type === "monthly") {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { start: toDateInput(start), end: toDateInput(end) };
  }
  const day = date.getDay() || 7;
  const start = new Date(date);
  start.setDate(date.getDate() - day + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: toDateInput(start), end: toDateInput(end) };
}

function toDateInput(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function unique(items) {
  return [...new Set((items || []).map((item) => String(item).trim()).filter(Boolean))];
}

function ensureRelatedProjects(names = []) {
  names.filter(Boolean).forEach((name) => {
    if (projectIdByName(name)) return;
    upsertProject({
      id: uid("project"),
      userId: currentUserId(),
      name,
      description: "由快速记录自动识别创建",
      status: "active",
      startDate: todayISO(),
      endDate: ""
    });
  });
}

function projectIdByName(name) {
  if (!name) return "";
  return db.prepare("SELECT id FROM projects WHERE name = ?").get(name)?.id || "";
}

function recordFromRow(row) {
  const record = { ...row };
  jsonFields.forEach((field) => {
    record[field] = parseArray(row[field]);
  });
  return record;
}

function taskFromRow(row) {
  return {
    ...row,
    status: statusFromDb(row.status),
    priority: priorityFromDb(row.priority)
  };
}

function projectFromRow(row) {
  return {
    ...row,
    status: projectStatusFromDb(row.status)
  };
}

function summaryFromRow(row) {
  return {
    ...row,
    type: summaryTypeFromDb(row.type)
  };
}

function preferenceFromRow(row) {
  return { ...row };
}

function normalizeTaskStatus(status) {
  return {
    未开始: "todo",
    进行中: "doing",
    已完成: "done",
    todo: "todo",
    doing: "doing",
    done: "done"
  }[status] || "todo";
}

function normalizePriority(priority) {
  return {
    高: "high",
    中: "medium",
    低: "low",
    high: "high",
    medium: "medium",
    low: "low"
  }[priority] || "medium";
}

function normalizeProjectStatus(status) {
  return {
    进行中: "active",
    已完成: "done",
    暂停: "paused",
    active: "active",
    done: "done",
    paused: "paused"
  }[status] || "active";
}

function normalizeSummaryType(type) {
  return {
    daily: "daily",
    tomorrow: "tomorrow_plan",
    tomorrow_plan: "tomorrow_plan",
    leader: "leader_report",
    leader_report: "leader_report",
    weekly: "weekly",
    monthly: "monthly",
    project: "project",
    review: "review"
  }[type] || "weekly";
}

function statusFromDb(status) {
  return { todo: "未开始", doing: "进行中", done: "已完成" }[status] || status;
}

function priorityFromDb(priority) {
  return { high: "高", medium: "中", low: "低" }[priority] || priority;
}

function projectStatusFromDb(status) {
  return { active: "进行中", done: "已完成", paused: "暂停" }[status] || status;
}

function summaryTypeFromDb(type) {
  return { tomorrow_plan: "tomorrow", leader_report: "leader" }[type] || type;
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function inferPriority(title) {
  if (/风险|紧急|今天|明天|审批|发布|客户/.test(title)) return "high";
  if (/整理|优化|跟进|确认/.test(title)) return "medium";
  return "low";
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function tomorrowISO() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function readBuffer(req, limit = 25_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function getHealthStatus() {
  return {
    ok: true,
    service: "afterwork-five-minutes",
    time: nowISO(),
    auth: {
      users: authDb.prepare("SELECT COUNT(*) AS count FROM users").get().count
    },
    data: {
      dir: DATA_DIR,
      authDatabase: AUTH_DB_PATH,
      userDatabaseDir: USER_DATA_DIR,
      legacyDatabaseExists: fs.existsSync(LEGACY_DB_PATH)
    },
    ai: aiService.getAIStatus(),
    speech: speechService.getSpeechStatus()
  };
}

function getAuthStatus(req) {
  const user = getSessionUser(req);
  return {
    enabled: true,
    authenticated: Boolean(user),
    user: user ? publicUser(user) : null
  };
}

function getSessionUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  const userId = token ? sessions.get(token) : "";
  if (!userId) return null;
  return getUserById(userId);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, userId);
  return token;
}

function createUserAccount(input = {}) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  const name = normalizeName(input.name, email);
  if (!email) return { error: "请输入有效邮箱" };
  if (password.length < 6) return { error: "密码至少需要 6 位" };
  const existing = getUserByEmail(email);
  if (existing) return { status: 409, error: "这个邮箱已经注册" };

  const isFirstUser = authDb.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0;
  const now = nowISO();
  const id = uid("user");
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, passwordSalt);
  authDb.prepare(`
    INSERT INTO users (id, email, name, passwordHash, passwordSalt, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, name, passwordHash, passwordSalt, now, now);

  ensureUserDatabase(id, { inheritLegacy: isFirstUser });
  return { user: getUserById(id) };
}

function verifyUserLogin(emailInput, passwordInput) {
  const user = getUserByEmail(emailInput);
  if (!user) return null;
  const passwordHash = hashPassword(String(passwordInput || ""), user.passwordSalt);
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(passwordHash, "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  ensureUserDatabase(user.id);
  return user;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

function normalizeName(name, email) {
  const value = String(name || "").trim();
  if (value) return value.slice(0, 40);
  return email.split("@")[0].slice(0, 40) || "职场用户";
}

function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return authDb.prepare("SELECT * FROM users WHERE email = ?").get(normalized) || null;
}

function getUserById(id) {
  if (!id) return null;
  return authDb.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function currentUser() {
  const store = requestContext.getStore();
  if (!store?.user) throw new Error("No user is bound to this request");
  return store.user;
}

function currentUserId() {
  return currentUser().id;
}

function getUserDatabase(userId) {
  ensureUserDatabase(userId);
  if (userDatabases.has(userId)) return userDatabases.get(userId);
  const database = new DatabaseSync(userDatabasePath(userId));
  initializeBusinessDatabase(database);
  userDatabases.set(userId, database);
  return database;
}

function ensureUserDatabase(userId, options = {}) {
  const target = userDatabasePath(userId);
  if (!fs.existsSync(target)) {
    if (options.inheritLegacy && fs.existsSync(LEGACY_DB_PATH)) {
      checkpointLegacyDatabase();
      fs.copyFileSync(LEGACY_DB_PATH, target);
    } else {
      fs.closeSync(fs.openSync(target, "a"));
    }
  }
  const database = new DatabaseSync(target);
  initializeBusinessDatabase(database);
  rewriteDatabaseUserIds(database, userId);
  database.close();
}

function initializeBusinessDatabase(database) {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(businessSchema);
  ensureColumnOn(database, "projects", "startDate", "TEXT");
  ensureColumnOn(database, "projects", "endDate", "TEXT");
}

function checkpointLegacyDatabase() {
  const legacy = new DatabaseSync(LEGACY_DB_PATH);
  legacy.exec("PRAGMA wal_checkpoint(FULL)");
  legacy.close();
}

function ensureColumnOn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function rewriteDatabaseUserIds(database, userId) {
  ["work_records", "tasks", "projects", "summaries", "user_preferences"].forEach((table) => {
    database.prepare(`UPDATE ${table} SET userId = ? WHERE userId = ? OR userId = '' OR userId IS NULL`).run(userId, DEFAULT_USER_ID);
  });
}

function userDatabasePath(userId) {
  if (!/^user_[a-z0-9_]+$/i.test(userId)) throw new Error("Invalid user id");
  return path.join(USER_DATA_DIR, `${userId}.sqlite`);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) return;
    process.env[key] = parseEnvValue(rawValue);
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

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const pair = header
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}

function buildSessionCookie(token) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}${secure}`;
}

function serveStatic(res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const file = path.normalize(path.join(ROOT, requestPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}
