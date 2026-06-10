const STORAGE_KEY = "afterwork-five-minutes-v1";
const API_BASE = "/api";
const VOICE_MAX_DURATION_MS = 3 * 60 * 1000;

const routes = [
  { id: "dashboard", label: "今日概览", icon: "⌂" },
  { id: "record", label: "工作记录", icon: "✎" },
  { id: "summary", label: "报告中心", icon: "▤" },
  { id: "tasks", label: "待办管理", icon: "✓" },
  { id: "projects", label: "项目归档", icon: "◇" },
  { id: "history", label: "复盘与洞察", icon: "◷" },
  { id: "preferences", label: "设置", icon: "⚙" }
];

const categories = [
  ["completedItems", "今日完成"],
  ["ongoingItems", "进行中事项"],
  ["tomorrowTasks", "明日待办"],
  ["projectProgress", "项目进展"],
  ["risks", "问题与风险"],
  ["reflections", "想法与反思"],
  ["followUpPeople", "需跟进对象"],
  ["relatedProjects", "相关项目"],
  ["uncategorizedItems", "未分类事项"]
];

const primaryRecordCategories = [
  ["completedItems", "已完成"],
  ["ongoingItems", "进行中"],
  ["tomorrowTasks", "待办事项"]
];

const summaryTypes = [
  ["weekly", "周报"],
  ["monthly", "月报"]
];

let state = createInitialState();
let draftRecord = null;
let summaryDraft = null;
let toastTimer = null;
let apiAvailable = true;
let aiStatus = null;
let speechStatus = null;
let authRequired = false;
let authChecked = false;
let voiceSession = null;

window.addEventListener("hashchange", render);
document.addEventListener("DOMContentLoaded", initApp);

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
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

function nowISO() {
  return new Date().toISOString();
}

function cnDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(date);
}

function shortDate(dateString) {
  const [, month, day] = dateString.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function currentRoute() {
  const id = location.hash.replace("#", "");
  return routes.some((route) => route.id === id) ? id : "dashboard";
}

async function initApp() {
  try {
    await ensureAuth();
    if (authRequired) {
      render();
      return;
    }
    const remote = await apiGet("/state");
    if (remote.meta?.isEmpty) {
      const legacy = readLegacyState() || createInitialState();
      const imported = await apiPost("/import-state", { state: legacy });
      applyRemoteState(imported);
    } else {
      applyRemoteState(remote);
    }
  } catch (error) {
    console.error(error);
    if (error.status === 401 || error.authRequired) {
      authRequired = true;
      authChecked = true;
      render();
      return;
    }
    apiAvailable = false;
    showToast("本地 API 暂不可用，已临时使用浏览器本地数据。");
    state = readLegacyState() || createInitialState();
  }
  if (apiAvailable) {
    await refreshAIStatus(false);
    await refreshSpeechStatus(false);
  }
  render();
}

async function ensureAuth() {
  const status = await apiGet("/auth/status");
  authChecked = true;
  authRequired = status.enabled && !status.authenticated;
  return status;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function readLegacyState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function applyRemoteState(remote) {
  state.user = remote.user || state.user;
  state.preferences = remote.preferences || state.preferences;
  state.records = remote.records || [];
  state.tasks = remote.tasks || [];
  state.projects = remote.projects || [];
  state.summaries = remote.summaries || [];
  state.ui = { ...createInitialState().ui, ...(state.ui || {}) };
  if (!summaryTypes.some(([type]) => type === state.ui.summaryType)) state.ui.summaryType = "weekly";
  if (!state.ui.selectedProjectId && state.projects[0]) state.ui.selectedProjectId = state.projects[0].id;
  saveState();
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  return parseApiResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return parseApiResponse(response);
}

async function apiPut(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return parseApiResponse(response);
}

async function apiDelete(path) {
  const response = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(response.ok ? "API 返回格式异常" : `API ${response.status}`);
  }
  if (!response.ok) {
    const error = new Error(payload.error || `API ${response.status}`);
    error.status = response.status;
    error.authRequired = Boolean(payload.authRequired);
    throw error;
  }
  return payload;
}

async function withApiFallback(request, fallback) {
  if (!apiAvailable) return fallback();
  try {
    return await request();
  } catch (error) {
    if (error.status === 401 || error.authRequired) {
      authRequired = true;
      render();
      throw error;
    }
    console.warn(error);
    apiAvailable = false;
    return fallback();
  }
}

function parseRecordInput(rawInput) {
  return withApiFallback(
    () => apiPost("/records/parse", { rawInput }),
    () => aiOrganize(rawInput)
  );
}

function generateSummaryDraft(recordId, type) {
  return withApiFallback(
    () => apiPost("/summaries/generate", { recordId, type, date: todayISO() }),
    () => {
      const record = type === "weekly" || type === "monthly"
        ? buildPeriodRecord(type, todayISO())
        : state.records.find((item) => item.id === recordId);
      return { content: record ? generateSummary(record, type) : "", recordId: record?.id || recordId };
    }
  );
}

function polishTextDraft(text) {
  return withApiFallback(
    () => apiPost("/text/polish", { text }),
    () => ({ text: polishTextLocal(text), _meta: { aiMode: "mock", fallbackReason: "本地规则" } })
  );
}

async function refreshAIStatus(showResult = true) {
  try {
    aiStatus = await apiGet("/ai/status");
    if (showResult) showToast(aiStatus.enabled ? "真实 AI 已配置。" : "当前为 mock 模式。");
  } catch (error) {
    aiStatus = { enabled: false, mode: "mock", error: error.message };
    if (showResult) showToast("AI 状态读取失败。");
  }
}

async function refreshSpeechStatus(showResult = true) {
  try {
    speechStatus = await apiGet("/speech/status");
    if (showResult) showToast(speechStatus.enabled ? "后端语音转写已配置。" : "当前仅使用浏览器语音识别。");
  } catch (error) {
    speechStatus = { enabled: false, mode: "browser-only", error: error.message };
    if (showResult) showToast("语音状态读取失败。");
  }
}

function notifyAIMode(meta) {
  if (!meta) return;
  if (meta.aiMode === "real") {
    showToast("已使用 DeepSeek 真实 AI 完成。");
  } else if (meta.fallbackReason) {
    showToast(`AI 暂不可用，已使用本地规则完成：${meta.fallbackReason}`);
  }
}

function persistSummary(recordId, type, content) {
  return withApiFallback(
    () => apiPost("/summaries", { recordId, type, content }),
    () => {
      upsertSummary(recordId, type, content);
      saveState();
      return { state, summary: findLatestSummary(type, recordId) };
    }
  );
}

function deleteSummaryById(summaryId) {
  return withApiFallback(
    () => apiDelete(`/summaries/${summaryId}`),
    () => {
      state.summaries = state.summaries.filter((summary) => summary.id !== summaryId);
      saveState();
      return state;
    }
  );
}

function deleteRecordById(recordId) {
  return withApiFallback(
    () => apiDelete(`/records/${recordId}`),
    () => {
      state.records = state.records.filter((record) => record.id !== recordId);
      state.summaries = state.summaries.filter((summary) => summary.recordId !== recordId);
      state.tasks = state.tasks.map((task) => task.sourceRecordId === recordId ? { ...task, sourceRecordId: "" } : task);
      saveState();
      return state;
    }
  );
}

function saveProject(project) {
  return withApiFallback(
    () => project.id ? apiPut(`/projects/${project.id}`, project) : apiPost("/projects", project),
    () => {
      const existingIndex = state.projects.findIndex((item) => item.id === project.id || item.name === project.name);
      const saved = {
        id: project.id || state.projects[existingIndex]?.id || uid("project"),
        userId: state.user.id,
        name: project.name || "",
        description: project.description || "",
        status: project.status || "进行中",
        startDate: project.startDate || "",
        endDate: project.endDate || "",
        createdAt: state.projects[existingIndex]?.createdAt || nowISO(),
        updatedAt: nowISO()
      };
      if (existingIndex >= 0) state.projects[existingIndex] = saved;
      else state.projects.unshift(saved);
      saveState();
      return { project: saved, state };
    }
  );
}

function generateProjectReview(projectId) {
  return withApiFallback(
    () => apiPost(`/projects/${projectId}/review`, {}),
    () => {
      const project = state.projects.find((item) => item.id === projectId);
      const content = generateProjectReviewText(project);
      upsertSummary(`project_${projectId}`, "project", content);
      saveState();
      return { summary: findLatestSummary("project", `project_${projectId}`), state };
    }
  );
}

function createInitialState() {
  const today = todayISO();
  const userId = "user_default";
  const projectA = uid("project");
  const projectB = uid("project");
  const recordId = uid("record");
  return {
    user: {
      id: userId,
      name: "职场用户",
      email: "user@example.com",
      createdAt: nowISO(),
      updatedAt: nowISO()
    },
    preferences: {
      id: uid("pref"),
      userId,
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
      createdAt: nowISO(),
      updatedAt: nowISO()
    },
    projects: [
      {
        id: projectA,
        userId,
        name: "品牌内容运营",
        description: "日常内容、宣传物料与活动传播归档。",
        status: "进行中",
        startDate: today,
        endDate: "",
        createdAt: nowISO(),
        updatedAt: nowISO()
      },
      {
        id: projectB,
        userId,
        name: "发布会筹备",
        description: "脚本、排期、素材与跨团队协作事项。",
        status: "进行中",
        startDate: today,
        endDate: "",
        createdAt: nowISO(),
        updatedAt: nowISO()
      }
    ],
    records: [
      {
        id: recordId,
        userId,
        date: today,
        rawInput:
          "今天上午和设计沟通了宣传册修改，下午整理了播客选题，科学北极星发布会视频脚本还需要明天继续改。今天感觉项目内容有点散，后面需要按优先级整理。",
        completedItems: ["和设计沟通宣传册修改", "整理播客选题"],
        ongoingItems: ["科学北极星发布会视频脚本继续优化"],
        tomorrowTasks: ["继续修改科学北极星发布会视频脚本"],
        projectProgress: ["发布会筹备：视频脚本进入修改阶段", "品牌内容运营：播客选题已完成整理"],
        risks: ["项目内容较散，需要梳理优先级"],
        reflections: ["后续需要按优先级整理工作事项"],
        followUpPeople: ["设计"],
        relatedProjects: ["品牌内容运营", "发布会筹备"],
        uncategorizedItems: [],
        createdAt: nowISO(),
        updatedAt: nowISO()
      }
    ],
    tasks: [
      {
        id: uid("task"),
        userId,
        title: "继续修改科学北极星发布会视频脚本",
        description: "基于今天的沟通结果继续收敛内容。",
        status: "进行中",
        priority: "高",
        dueDate: tomorrowISO(),
        relatedProjectId: projectB,
        sourceRecordId: recordId,
        createdAt: nowISO(),
        updatedAt: nowISO()
      },
      {
        id: uid("task"),
        userId,
        title: "整理播客选题优先级",
        description: "按发布节奏和内容价值排序。",
        status: "未开始",
        priority: "中",
        dueDate: today,
        relatedProjectId: projectA,
        sourceRecordId: recordId,
        createdAt: nowISO(),
        updatedAt: nowISO()
      }
    ],
    summaries: [],
    ui: {
      selectedProjectId: projectA,
      editProjectId: "",
      taskFilterStatus: "全部",
      taskFilterPriority: "全部",
      taskFilterDate: "全部",
      historyDate: today,
      historyKeyword: "",
      historyProject: "全部",
      expandedRecordId: "",
      summaryType: "weekly"
    }
  };
}

function render() {
  if (authRequired) {
    document.getElementById("app").innerHTML = renderAuthGate();
    bindAuthGate();
    return;
  }
  const route = currentRoute();
  document.getElementById("app").innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <span></span><span></span><span></span><span></span>
          </div>
          <div>
            <h1 class="brand-title">下班前五分钟</h1>
            <p class="brand-subtitle">Work Summary Cockpit</p>
          </div>
        </div>
        <nav class="nav">
          ${routes
            .map(
              (item) => `
                <button class="${route === item.id ? "active" : ""}" data-route="${item.id}">
                  <span class="nav-icon">${item.icon}</span>
                  <span>${item.label}</span>
                </button>
              `
            )
            .join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="avatar">${escapeHtml(state.user.name.slice(0, 1) || "用")}</div>
          <div>
            <p class="profile-name">${escapeHtml(state.user.name)}</p>
            <p class="profile-role">${escapeHtml(state.preferences.role || "通用工作记录")}</p>
          </div>
          <span class="profile-caret">⌄</span>
        </div>
      </aside>
      <main class="main">${renderPage(route)}</main>
    </div>
  `;
  bindCommon();
  bindPage(route);
}

function renderAuthGate() {
  return `
    <main class="auth-screen">
      <section class="auth-card">
        <div class="brand auth-brand">
          <div class="brand-mark" aria-hidden="true">
            <span></span><span></span><span></span><span></span>
          </div>
          <div>
            <h1 class="brand-title">下班前五分钟</h1>
            <p class="brand-subtitle">内测访问</p>
          </div>
        </div>
        <h2>输入访问口令</h2>
        <p>当前站点已开启少量内测保护。口令只用于进入应用，不会作为用户账号保存。</p>
        <div class="field">
          <label for="access-password">访问口令</label>
          <input id="access-password" type="password" autocomplete="current-password" placeholder="请输入内测口令" />
        </div>
        <button class="btn primary auth-submit" id="auth-submit">进入应用</button>
        <p class="auth-note">如需配置口令，请在服务端设置 <strong>APP_ACCESS_PASSWORD</strong> 环境变量。</p>
      </section>
    </main>
  `;
}

function bindAuthGate() {
  const submit = () => {
    handleAsync(async () => {
      const password = document.getElementById("access-password").value;
      if (!password) return showToast("请输入访问口令。");
      await apiPost("/auth/login", { password });
      authRequired = false;
      await initApp();
      showToast("已进入内测环境。");
    });
  };
  document.getElementById("auth-submit")?.addEventListener("click", submit);
  document.getElementById("access-password")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  setTimeout(() => document.getElementById("access-password")?.focus(), 0);
}

function bindCommon() {
  document.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", () => {
      location.hash = button.dataset.route;
    });
  });
}

function renderPage(route) {
  if (route === "record") return renderRecordPage();
  if (route === "summary") return renderSummaryPage();
  if (route === "tasks") return renderTasksPage();
  if (route === "projects") return renderProjectsPage();
  if (route === "history") return renderHistoryPage();
  if (route === "preferences") return renderPreferencesPage();
  return renderDashboard();
}

function renderTop(title, subtitle, actions = "") {
  return `
    <div class="topbar">
      <div>
        <p class="eyebrow">${subtitle}</p>
        <h2 class="page-title">${title}</h2>
      </div>
      <div class="page-actions">${actions}</div>
    </div>
  `;
}

function getTodayRecord() {
  return state.records.find((record) => record.date === todayISO()) || null;
}

function renderDashboard() {
  const today = todayISO();
  const record = getTodayRecord();
  const tasksToday = state.tasks.filter((task) => task.dueDate === today && task.status !== "已完成");
  const tasksTomorrow = state.tasks.filter((task) => task.dueDate === tomorrowISO() && task.status !== "已完成");
  const ongoing = state.tasks.filter((task) => task.status === "进行中");
  const finishedCount = record?.completedItems.length || state.tasks.filter((task) => task.status === "已完成").length;
  const dimensions = buildDimensionStats(record);
  return `
    ${renderTop("下午好，开始收尾 ☼", cnDate(today), `
      ${renderAIBadge()}
      <button class="notify-btn" title="通知">♢</button>
    `)}
    <div class="layout-grid">
      <div class="stack">
        <section class="panel hero-record">
          <div class="hero-content">
            <div>
              <h3 class="hero-title">点击开始工作记录</h3>
              <p class="section-note">用文字或预留语音入口记录今天的工作内容</p>
              <div class="voice-stage">
                <div class="wave wave-left"></div>
                <button class="record-orb ${voiceSession?.targetId === "dash-input" ? "listening" : ""}" id="dash-voice" title="语音入口" aria-label="语音输入入口">
                  <span class="mic-icon"></span>
                </button>
                <div class="wave wave-right"></div>
              </div>
              <p class="timer" id="dash-voice-status">${voiceSession?.targetId === "dash-input" ? "正在听写..." : `最长 ${formatVoiceDuration(VOICE_MAX_DURATION_MS)}`}</p>
              <p class="section-note">建议 1-3 分钟，到时自动停止，语音会转成文字并润色后再整理归纳</p>
              <div class="quick-box">
                <textarea id="dash-input" placeholder="也可以直接输入：上午对齐活动页面，下午整理客户反馈，明天继续跟进合同审批。"></textarea>
                <div class="button-row" style="justify-content:center;">
                  <button class="btn" id="dash-polish">润色文本</button>
                  <button class="btn primary" id="dash-organize">✦ 保存并整理</button>
                  <button class="btn" data-route="record">打开工作记录</button>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-inner">
            <div class="section-head">
              <div>
                <h3 class="section-title">最近记录</h3>
                <p class="section-note">按日期归档，方便后续生成周报和复盘。</p>
              </div>
              <button class="btn ghost" data-route="history">查看全部 ›</button>
            </div>
            ${renderRecentRecords()}
          </div>
        </section>
      </div>
      <aside class="stack">
        <section class="panel">
          <div class="panel-inner">
            <div class="section-head">
              <h3 class="section-title">今日概览</h3>
              <button class="btn ghost" data-route="history">查看全部 ›</button>
            </div>
            <div class="stats-grid">
              ${renderMetric("完成事项", finishedCount, "项", "✓", "blue")}
              ${renderMetric("待办事项", tasksToday.length + tasksTomorrow.length, "项", "◷", "blue")}
              ${renderMetric("问题卡点", record?.risks.length || 0, "个", "?", "amber")}
              ${renderMetric("复盘记录", state.summaries.length ? "已完成" : "未生成", "", "▤", "green")}
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-inner">
            <div class="section-head">
              <div>
                <h3 class="section-title">项目快录</h3>
                <p class="section-note">先手动创建项目，后续语音记录会自动识别并关联项目名。</p>
              </div>
              <button class="btn ghost" data-route="projects">项目归档 ›</button>
            </div>
            <div class="mini-project-form">
              <input id="dash-project-name" placeholder="项目名称" />
              <input id="dash-project-start" type="date" value="${today}" />
              <button class="btn primary" id="dash-save-project">＋ 保存项目</button>
            </div>
            <div class="badge-row">
              ${state.projects.slice(0, 3).map((project) => `<span class="badge">${escapeHtml(project.name)}</span>`).join("") || `<span class="badge">暂无项目</span>`}
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-inner">
            <div class="section-head">
              <h3 class="section-title">工作维度分布</h3>
            </div>
            ${renderDimensionDistribution(dimensions)}
          </div>
        </section>
        <section class="panel">
          <div class="panel-inner">
            <div class="section-head">
              <h3 class="section-title">快捷操作</h3>
            </div>
            <div class="quick-actions">
              <button data-quick-summary="weekly"><span>▤</span>生成周报</button>
              <button data-quick-summary="monthly"><span>□</span>生成月报</button>
              <button data-route="tasks"><span>✓</span>管理待办</button>
              <button data-route="history"><span>◷</span>复盘洞察</button>
            </div>
          </div>
        </section>
      </aside>
    </div>
    <p class="footer-line">记录你的每一份努力，让成长清晰可见</p>
  `;
}

function renderAIBadge() {
  const real = aiStatus?.mode === "real";
  const label = real ? `真实 AI · ${aiStatus.model || "DeepSeek"}` : "Mock AI";
  return `<button class="btn ai-mode-badge ${real ? "real" : "mock"}" data-route="preferences" title="查看 AI 状态">${escapeHtml(label)}</button>`;
}

function renderRecentRecords() {
  const records = state.records.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  if (!records.length) return `<div class="empty">暂无记录</div>`;
  return `
    <div class="recent-list">
      ${records
        .map((record, index) => {
          const title = record.relatedProjects[0] || record.completedItems[0] || "工作记录";
          const desc = [...record.completedItems, ...record.tomorrowTasks].slice(0, 2).join("，") || record.rawInput;
          return `
            <button class="recent-card" data-open-record="${record.date}">
              <div class="recent-date">
                <strong>${shortDate(record.date)}</strong>
                <span>${new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(new Date(`${record.date}T00:00:00`))}</span>
              </div>
              <i class="status-dot ${index === 0 ? "" : index === 1 ? "violet" : "amber"}"></i>
              <div>
                <p class="item-title">${escapeHtml(title)}</p>
                <p class="item-desc">${escapeHtml(desc)}</p>
              </div>
              <span class="recent-arrow">›</span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderMetric(label, value, unit, icon, color) {
  const valueClass = typeof value === "number" ? "" : "text-metric";
  return `
    <div class="metric-card">
      <div class="metric-icon ${color}">${icon}</div>
      <div>
        <span>${label}</span>
        <strong class="${valueClass}">${value}<small>${unit}</small></strong>
      </div>
    </div>
  `;
}

function buildDimensionStats(record) {
  const base = [
    ["项目推进", record?.projectProgress.length || 3],
    ["内容整理", record?.completedItems.length || 2],
    ["待办计划", record?.tomorrowTasks.length || 2],
    ["风险复盘", record?.risks.length + record?.reflections.length || 1]
  ];
  const total = base.reduce((sum, item) => sum + item[1], 0) || 1;
  return base.map(([label, value]) => ({ label, value, percent: Math.round((value / total) * 100) }));
}

function renderDimensionDistribution(dimensions) {
  return `
    <div class="dimension-box">
      <div class="donut" style="--p1:${dimensions[0].percent}; --p2:${dimensions[1].percent}; --p3:${dimensions[2].percent};">
        <div><span>本周</span><strong>${dimensions.reduce((sum, item) => sum + item.value, 0)}</strong><span>项</span></div>
      </div>
      <div class="dimension-legend">
        ${dimensions
          .map(
            (item, index) => `
              <div>
                <i class="status-dot ${index === 1 ? "violet" : index === 2 ? "green" : index === 3 ? "amber" : ""}"></i>
                <span>${item.label}</span>
                <strong>${item.percent}%</strong>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
    <button class="btn ghost" data-route="history" style="margin-top:16px;">查看详情 ›</button>
  `;
}

function renderRecordPage() {
  const record = draftRecord || getTodayRecord();
  return `
    ${renderTop("快速记录", "先记录，再整理", `
      <button class="btn ${voiceSession?.targetId === "record-raw" ? "listening" : ""}" id="voice-placeholder">◎ ${voiceSession?.targetId === "record-raw" ? "停止听写" : "语音输入"}</button>
      <button class="btn" id="polish-record-text">润色文本</button>
      <button class="btn primary" id="organize-record">✦ AI 整理</button>
    `)}
    <div class="layout-grid">
      <section class="panel">
        <div class="panel-inner">
          <div class="section-head">
            <div>
              <h3 class="section-title">自然语言输入</h3>
              <p class="section-note">${aiStatus?.mode === "real" ? "DeepSeek 负责文字整理和总结。" : "当前使用本地规则模拟 AI，配置 API key 后可切换真实 AI。"}</p>
            </div>
          </div>
          ${renderPrivacyNotice()}
          ${renderVoiceNotice()}
          <textarea id="record-raw" placeholder="把今天的工作用口语写下来，完成事项、明日待办、风险、想法都可以混在一起。">${escapeHtml(record?.rawInput || "")}</textarea>
          <div class="button-row">
            <button class="btn" id="polish-record-bottom">润色文本</button>
            <button class="btn primary" id="organize-record-bottom">✦ 整理为结构化记录</button>
            <button class="btn" id="load-example">填入示例</button>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-inner">
          <h3 class="section-title">保存状态</h3>
          <p class="section-note">保存时以右侧可编辑内容为准。</p>
          <div class="badge-row" style="margin-top:18px;">
            <span class="badge">日期：${todayISO()}</span>
            <span class="badge">字段：${primaryRecordCategories.length}</span>
            <span class="badge">AI：${aiStatus?.mode === "real" ? "DeepSeek" : "mock service"}</span>
          </div>
        </div>
      </section>
    </div>
    <section class="panel" style="margin-top:24px;">
      <div class="panel-inner">
        <div class="section-head">
          <div>
            <h3 class="section-title">整理结果预览</h3>
            <p class="section-note">每行一条，用户确认后保存。</p>
          </div>
          <button class="btn primary" id="save-record">✓ 保存记录</button>
        </div>
        <div class="structured-grid">
          ${primaryRecordCategories
            .map(
              ([key, label]) => `
                <div class="field">
                  <label for="field-${key}">${label}</label>
                  <textarea id="field-${key}" data-category="${key}" placeholder="每行一条">${escapeHtml((record?.[key] || []).join("\n"))}</textarea>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    </section>
  `;
}

function renderPrivacyNotice() {
  return `
    <div class="notice privacy-notice">
      ${aiStatus?.mode === "real"
        ? "真实 AI 模式下，输入内容会发送到 DeepSeek 用于整理和生成总结。请勿输入密码、密钥、身份证号等敏感信息。"
        : "当前为 Mock 模式，内容仅在本地服务和 SQLite 中处理。切换真实 AI 后请避免输入敏感信息。"}
    </div>
  `;
}

function renderVoiceNotice() {
  const backendReady = speechStatus?.enabled;
  return `
    <div class="notice voice-notice">
      ${backendReady
        ? `语音转文字后端已配置：${escapeHtml(speechStatus.model || "STT")}。单次最长 ${formatVoiceDuration(VOICE_MAX_DURATION_MS)}，到时自动停止并润色。`
        : `语音转文字当前只依赖浏览器内置识别。单次最长 ${formatVoiceDuration(VOICE_MAX_DURATION_MS)}；若提示“网络不可用”，需要配置 STT_API_KEY 后才能用后端录音转写。`}
    </div>
  `;
}

function renderSummaryPage() {
  const record = getTodayRecord();
  const summaryRecordId = summaryTargetRecordId(state.ui.summaryType);
  const saved = findLatestSummary(state.ui.summaryType, summaryRecordId);
  const dailySummary = record ? findLatestSummary("daily", record.id) : null;
  const generated = summaryDraft?.recordId === summaryRecordId && summaryDraft?.type === state.ui.summaryType
    ? summaryDraft
    : saved;
  return `
    ${renderTop("报告中心", "周报、月报与今日日报", `
      <button class="btn primary" id="save-summary">✓ 保存总结</button>
    `)}
    <div class="layout-grid">
      <section class="panel">
        <div class="panel-inner">
          <div class="section-head">
            <div>
              <h3 class="section-title">今日结构化记录</h3>
              <p class="section-note">${record ? `${cnDate(record.date)} · 仅显示已完成、进行中、待办事项` : "今天还没有保存工作记录"}</p>
            </div>
            <div class="button-row" style="margin-top:0;">
              <button class="btn" data-route="record">编辑记录</button>
              <button class="btn primary" id="auto-daily-summary" ${record ? "" : "disabled"}>自动生成日报</button>
            </div>
          </div>
          ${record ? renderStructuredReadOnly(record) : `<div class="empty">先保存一条快速记录</div>`}
          ${dailySummary ? `
            <div class="daily-summary-preview">
              <div class="section-head">
                <h4>今日日报</h4>
                <button class="btn ghost" data-copy-summary="${dailySummary.id}">复制</button>
              </div>
              <p class="item-desc">${escapeHtml(dailySummary.content.slice(0, 260))}${dailySummary.content.length > 260 ? "..." : ""}</p>
            </div>
          ` : ""}
        </div>
      </section>
      <section class="panel">
        <div class="panel-inner">
          <div class="section-head">
            <h3 class="section-title">生成类型</h3>
          </div>
          <div class="tabs">
            ${summaryTypes
              .map(
                ([type, label]) => `
                  <button class="tab ${state.ui.summaryType === type ? "active" : ""}" data-summary-tab="${type}">${label}</button>
                `
              )
              .join("")}
          </div>
          <p class="section-note" style="margin-top:14px;">${periodSummaryHint(state.ui.summaryType)}</p>
          <div class="button-row">
            <button class="btn primary" id="generate-summary" ${state.records.length ? "" : "disabled"}>✦ 生成${summaryTypeLabel(state.ui.summaryType)}</button>
            <button class="btn" id="copy-summary" ${generated ? "" : "disabled"}>□ 复制</button>
          </div>
        </div>
      </section>
    </div>
    <section class="panel" style="margin-top:24px;">
      <div class="panel-inner">
        <div class="section-head">
          <h3 class="section-title">可编辑生成结果</h3>
          <span class="badge">${summaryTypeLabel(state.ui.summaryType)}</span>
        </div>
        <textarea class="generated-output" id="summary-output" placeholder="点击生成文本后，可在这里继续编辑。">${escapeHtml(generated?.content || "")}</textarea>
      </div>
    </section>
  `;
}

function renderTasksPage() {
  const filtered = state.tasks.filter((task) => {
    const statusOk = state.ui.taskFilterStatus === "全部" || task.status === state.ui.taskFilterStatus;
    const priorityOk = state.ui.taskFilterPriority === "全部" || task.priority === state.ui.taskFilterPriority;
    const dateOk =
      state.ui.taskFilterDate === "全部" ||
      (state.ui.taskFilterDate === "今日" && task.dueDate === todayISO()) ||
      (state.ui.taskFilterDate === "明日" && task.dueDate === tomorrowISO()) ||
      (state.ui.taskFilterDate === "未来" && task.dueDate > tomorrowISO());
    return statusOk && priorityOk && dateOk;
  });
  return `
    ${renderTop("待办管理", "今日、明日、未来", `
      <button class="btn primary" id="add-task">＋ 新增待办</button>
    `)}
    <section class="panel">
      <div class="panel-inner">
        <div class="filters">
          <select id="filter-status">
            ${["全部", "未开始", "进行中", "已完成"].map((item) => `<option ${state.ui.taskFilterStatus === item ? "selected" : ""}>${item}</option>`).join("")}
          </select>
          <select id="filter-priority">
            ${["全部", "高", "中", "低"].map((item) => `<option ${state.ui.taskFilterPriority === item ? "selected" : ""}>${item}</option>`).join("")}
          </select>
          <select id="filter-date">
            ${["全部", "今日", "明日", "未来"].map((item) => `<option ${state.ui.taskFilterDate === item ? "selected" : ""}>${item}</option>`).join("")}
          </select>
          <button class="btn" id="clear-task-filter">清空筛选</button>
        </div>
        <div id="task-form" style="display:none; margin-bottom:18px;">
          ${renderTaskForm()}
        </div>
        ${renderTaskList(filtered, true)}
      </div>
    </section>
  `;
}

function renderTaskForm(task = null) {
  return `
    <div class="panel" style="box-shadow:none;">
      <div class="panel-inner">
        <div class="form-grid three">
          <div class="field full">
            <label>事项标题</label>
            <input id="task-title" value="${escapeHtml(task?.title || "")}" />
          </div>
          <div class="field full">
            <label>事项描述</label>
            <textarea id="task-desc">${escapeHtml(task?.description || "")}</textarea>
          </div>
          <div class="field">
            <label>状态</label>
            <select id="task-status">${["未开始", "进行中", "已完成"].map((item) => `<option ${task?.status === item ? "selected" : ""}>${item}</option>`).join("")}</select>
          </div>
          <div class="field">
            <label>优先级</label>
            <select id="task-priority">${["高", "中", "低"].map((item) => `<option ${task?.priority === item ? "selected" : ""}>${item}</option>`).join("")}</select>
          </div>
          <div class="field">
            <label>截止日期</label>
            <input id="task-due" type="date" value="${task?.dueDate || todayISO()}" />
          </div>
          <div class="field full">
            <label>关联项目</label>
            <select id="task-project">
              <option value="">无关联</option>
              ${state.projects.map((project) => `<option value="${project.id}" ${task?.relatedProjectId === project.id ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="button-row">
          <button class="btn primary" id="save-task" data-edit-id="${task?.id || ""}">✓ 保存待办</button>
          <button class="btn" id="cancel-task">取消</button>
        </div>
      </div>
    </div>
  `;
}

function renderProjectsPage() {
  const selected = state.projects.find((project) => project.id === state.ui.selectedProjectId) || state.projects[0];
  if (selected && state.ui.selectedProjectId !== selected.id) {
    state.ui.selectedProjectId = selected.id;
    saveState();
  }
  const editing = state.projects.find((project) => project.id === state.ui.editProjectId) || null;
  const projectTasks = selected ? state.tasks.filter((task) => task.relatedProjectId === selected.id) : [];
  const projectRecords = selected
    ? state.records.filter((record) => record.relatedProjects.includes(selected.name))
    : [];
  const projectSummaries = selected
    ? state.summaries.filter((summary) => summary.recordId === `project_${selected.id}` || projectRecords.some((record) => record.id === summary.recordId))
    : [];
  const projectRisks = projectRecords.flatMap((record) => record.risks || []);
  const nextSteps = [
    ...projectTasks.filter((task) => task.status !== "已完成").map((task) => task.title),
    ...projectRecords.flatMap((record) => record.tomorrowTasks || [])
  ];
  return `
    ${renderTop("项目归档", "基础归档与查看", `
      <button class="btn primary" id="save-project">${editing ? "✓ 保存修改" : "＋ 创建项目"}</button>
    `)}
    <section class="panel">
      <div class="panel-inner">
        <div class="split">
          <div>
            <div class="section-head"><h3 class="section-title">项目列表</h3></div>
            <div class="list">
              ${state.projects
                .map(
                  (project) => `
                    <button class="item compact ${selected?.id === project.id ? "active-project" : ""}" data-project-id="${project.id}" style="text-align:left;">
                      <div>
                        <p class="item-title">${escapeHtml(project.name)}</p>
                        <p class="item-meta">${escapeHtml(project.status)} · ${project.startDate || "未填开始"} 至 ${project.endDate || "进行中"} · ${projectTasksById(project.id).length} 个待办</p>
                      </div>
                      <span>›</span>
                    </button>
                  `
                )
                .join("")}
            </div>
            <div style="margin-top:18px;">
              <div class="form-grid">
                <div class="field full">
                  <label>项目名称</label>
                  <input id="project-name" value="${escapeHtml(editing?.name || "")}" />
                </div>
                <div class="field full">
                  <label>项目描述</label>
                  <textarea id="project-desc">${escapeHtml(editing?.description || "")}</textarea>
                </div>
                <div class="field full">
                  <label>项目状态</label>
                  <select id="project-status">
                    ${["进行中", "已完成", "暂停"].map((item) => `<option ${editing?.status === item ? "selected" : ""}>${item}</option>`).join("")}
                  </select>
                </div>
                <div class="field">
                  <label>开始日期</label>
                  <input id="project-start" type="date" value="${editing?.startDate || todayISO()}" />
                </div>
                <div class="field">
                  <label>收尾日期</label>
                  <input id="project-end" type="date" value="${editing?.endDate || ""}" />
                </div>
              </div>
              ${editing ? `<button class="btn" id="cancel-project-edit" style="margin-top:12px;">取消编辑</button>` : ""}
            </div>
          </div>
          <div>
            ${
              selected
                ? `
                  <div class="section-head">
                    <div>
                      <h3 class="section-title">${escapeHtml(selected.name)}</h3>
                      <p class="section-note">${escapeHtml(selected.description || "暂无描述")} · ${selected.startDate || "未填开始"} 至 ${selected.endDate || "进行中"}</p>
                    </div>
                    <div class="button-row" style="margin-top:0;">
                      <span class="badge">${escapeHtml(selected.status)}</span>
                      <button class="btn icon-btn" title="编辑项目" data-edit-project="${selected.id}">✎</button>
                      ${selected.status !== "已完成" ? `<button class="btn icon-btn" title="关闭并复盘" data-close-project="${selected.id}">✓</button>` : ""}
                      <button class="btn icon-btn" title="删除项目" data-delete-project="${selected.id}">×</button>
                    </div>
                  </div>
                  <h4>相关待办</h4>
                  ${renderTaskList(projectTasks.slice(0, 5))}
                  <h4 style="margin-top:22px;">相关记录</h4>
                  ${renderRecordCards(projectRecords)}
                  <h4 style="margin-top:22px;">相关总结</h4>
                  ${renderSummaryCards(projectSummaries)}
                  <h4 style="margin-top:22px;">问题与风险</h4>
                  ${renderPlainList(projectRisks)}
                  <h4 style="margin-top:22px;">下一步事项</h4>
                  ${renderPlainList([...new Set(nextSteps)].slice(0, 8))}
                `
                : `<div class="empty">创建第一个项目后开始归档</div>`
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderHistoryPage() {
  const records = state.records
    .filter((record) => {
      const keyword = state.ui.historyKeyword.trim();
      const dateOk = !state.ui.historyDate || record.date === state.ui.historyDate;
      const keywordOk = !keyword || JSON.stringify(record).includes(keyword);
      const projectOk = state.ui.historyProject === "全部" || record.relatedProjects.includes(state.ui.historyProject);
      return dateOk && keywordOk && projectOk;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return `
    ${renderTop("历史记录", "为周报、月报和阶段总结做准备", "")}
    <section class="panel">
      <div class="panel-inner">
        <div class="filters">
          <input id="history-date" type="date" value="${state.ui.historyDate || ""}" />
          <input id="history-keyword" placeholder="关键词搜索" value="${escapeHtml(state.ui.historyKeyword)}" />
          <select id="history-project">
            <option>全部</option>
            ${state.projects.map((project) => `<option ${state.ui.historyProject === project.name ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
          </select>
          <button class="btn" id="clear-history-filter">清空筛选</button>
        </div>
        ${renderRecordCards(records, true)}
      </div>
    </section>
  `;
}

function renderPreferencesPage() {
  const p = state.preferences;
  return `
    ${renderTop("个人定制", "预留工作画像与输出偏好", `
      <button class="btn primary" id="save-preferences">✓ 保存配置</button>
    `)}
    <section class="panel" style="margin-bottom:24px;">
      <div class="panel-inner">
        <div class="section-head">
          <div>
            <h3 class="section-title">AI 状态</h3>
            <p class="section-note">API key 只从服务端环境变量读取，不会显示在页面里，也不会写入 SQLite。</p>
          </div>
          <div class="button-row" style="margin-top:0;">
      <button class="btn" id="refresh-ai-status">刷新状态</button>
            <button class="btn primary" id="test-ai">测试 AI</button>
          </div>
        </div>
        <div class="stats-grid">
          ${renderAIStatusMetric("模式", aiStatus?.mode === "real" ? "真实 AI" : "Mock", aiStatus?.enabled ? "green" : "amber")}
          ${renderAIStatusMetric("模型", aiStatus?.model || "deepseek-v4-flash", "blue")}
          ${renderAIStatusMetric("接口", aiStatus?.baseUrlHost || "api.deepseek.com", "violet")}
          ${renderAIStatusMetric("Provider", aiStatus?.provider || "deepseek", "blue")}
        </div>
        ${renderPrivacyNotice()}
      </div>
    </section>
    <section class="panel" style="margin-bottom:24px;">
      <div class="panel-inner">
        <div class="section-head">
          <div>
            <h3 class="section-title">语音转文字</h3>
            <p class="section-note">优先使用浏览器语音识别；网络不可用时可切换后端 STT 备用通道。</p>
          </div>
          <div class="button-row" style="margin-top:0;">
            <button class="btn" id="refresh-speech-status">刷新语音状态</button>
          </div>
        </div>
        <div class="stats-grid">
          ${renderAIStatusMetric("模式", speechStatus?.enabled ? "后端 STT" : "浏览器识别", speechStatus?.enabled ? "green" : "amber")}
          ${renderAIStatusMetric("模型", speechStatus?.model || "未配置", "blue")}
          ${renderAIStatusMetric("接口", speechStatus?.baseUrlHost || "浏览器内置", "violet")}
          ${renderAIStatusMetric("Provider", speechStatus?.provider || "Web Speech", "blue")}
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-inner">
        <div class="form-grid">
          ${prefInput("role", "岗位角色", p.role)}
          ${prefInput("reportAudience", "汇报对象", p.reportAudience)}
          ${prefInput("outputStyle", "输出风格", p.outputStyle)}
          ${prefArea("workGoals", "工作目标", p.workGoals)}
          ${prefArea("categoryPreferences", "工作分类偏好", p.categoryPreferences)}
          ${prefArea("dailyTemplate", "常用日报模板", p.dailyTemplate)}
          ${prefArea("weeklyTemplate", "常用周报模板", p.weeklyTemplate)}
          ${prefArea("keyProjects", "重点项目", p.keyProjects)}
          ${prefArea("keywords", "常用关键词库", p.keywords)}
          ${prefArea("collaborators", "常用联系人/协作对象", p.collaborators)}
        </div>
      </div>
    </section>
  `;
}

function renderAIStatusMetric(label, value, color) {
  return `
    <div class="metric-card">
      <div class="metric-icon ${color}">AI</div>
      <div>
        <span>${label}</span>
        <strong class="text-metric">${escapeHtml(value || "-")}</strong>
      </div>
    </div>
  `;
}

function prefInput(key, label, value) {
  return `
    <div class="field">
      <label>${label}</label>
      <input data-pref="${key}" value="${escapeHtml(value || "")}" />
    </div>
  `;
}

function prefArea(key, label, value) {
  return `
    <div class="field full">
      <label>${label}</label>
      <textarea data-pref="${key}">${escapeHtml(value || "")}</textarea>
    </div>
  `;
}

function renderStructuredReadOnly(record) {
  return `
    <div class="structured-grid">
      ${primaryRecordCategories
        .map(
          ([key, label]) => `
            <div class="stat-card">
              <span>${label}</span>
              <div style="margin-top:12px;">${renderPlainList(record[key] || [], 5)}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderPlainList(items, limit = Infinity) {
  const list = (items || []).filter(Boolean).slice(0, limit);
  if (!list.length) return `<div class="empty">暂无内容</div>`;
  return `
    <div class="list">
      ${list.map((item) => `<div class="item compact"><p class="item-title">${escapeHtml(item)}</p></div>`).join("")}
    </div>
  `;
}

function renderTaskList(tasks, withActions = false) {
  if (!tasks.length) return `<div class="empty">暂无待办</div>`;
  return `
    <div class="list">
      ${tasks
        .map(
          (task) => `
            <div class="item">
              <span class="status-dot ${task.status === "已完成" ? "green" : task.priority === "高" ? "red" : task.priority === "中" ? "amber" : ""}"></span>
              <div>
                <p class="item-title">${escapeHtml(task.title)}</p>
                <p class="item-desc">${escapeHtml(task.description || "无描述")}</p>
                <div class="badge-row">
                  <span class="badge">${escapeHtml(task.status)}</span>
                  <span class="badge ${priorityClass(task.priority)}">${escapeHtml(task.priority)}</span>
                  <span class="badge">${task.dueDate || "未设置截止日期"}</span>
                  ${task.relatedProjectId ? `<span class="badge">${escapeHtml(projectName(task.relatedProjectId))}</span>` : ""}
                  ${task.sourceRecordId ? `<span class="badge">来源：${escapeHtml(recordDate(task.sourceRecordId))}</span>` : ""}
                </div>
              </div>
              ${
                withActions
                  ? `
                    <div class="button-row" style="margin-top:0;">
                      <button class="btn icon-btn" title="编辑" data-edit-task="${task.id}">✎</button>
                      <button class="btn icon-btn" title="完成" data-complete-task="${task.id}">✓</button>
                      <button class="btn icon-btn" title="删除" data-delete-task="${task.id}">×</button>
                    </div>
                  `
                  : ""
              }
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderRecordCards(records, showSummary = false) {
  if (!records.length) return `<div class="empty">暂无记录</div>`;
  return `
    <div class="list">
      ${records
        .map((record) => {
          const summary = findLatestSummary("daily", record.id);
          const expanded = showSummary && state.ui.expandedRecordId === record.id;
          return `
            <div class="item compact">
              <div>
                <p class="item-title">${shortDate(record.date)} · ${record.completedItems[0] || "工作记录"}</p>
                <p class="item-desc">${escapeHtml(record.rawInput)}</p>
                <div class="badge-row">
                  ${record.relatedProjects.map((project) => `<span class="badge">${escapeHtml(project)}</span>`).join("")}
                  <span class="badge">完成 ${record.completedItems.length}</span>
                  <span class="badge">待办 ${record.tomorrowTasks.length}</span>
                </div>
                ${showSummary && summary ? `<p class="item-desc">${escapeHtml(summary.content.slice(0, 160))}...</p>` : ""}
                ${expanded ? renderRecordDetails(record) : ""}
              </div>
              <div class="button-row" style="margin-top:0;">
                <button class="btn ghost" ${showSummary ? `data-toggle-record="${record.id}"` : `data-open-record="${record.date}"`}>${expanded ? "收起" : "查看"}</button>
                ${showSummary ? `<button class="btn ghost danger" data-delete-record="${record.id}">删除</button>` : ""}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderRecordDetails(record) {
  const summaries = state.summaries.filter((summary) => summary.recordId === record.id);
  return `
    <div class="record-details">
      <h4>原始输入</h4>
      <p class="item-desc">${escapeHtml(record.rawInput || "暂无原始输入")}</p>
      <h4>结构化内容</h4>
      <div class="structured-grid">
        ${categories
          .map(
            ([key, label]) => `
              <div class="stat-card">
                <span>${label}</span>
                <div style="margin-top:12px;">${renderPlainList(record[key] || [], 4)}</div>
              </div>
            `
          )
          .join("")}
      </div>
      <h4>已生成总结</h4>
      ${renderSummaryCards(summaries)}
    </div>
  `;
}

function renderSummaryCards(summaries) {
  if (!summaries.length) return `<div class="empty">暂无总结</div>`;
  return `
    <div class="list">
      ${summaries
        .map(
          (summary) => `
            <div class="item compact">
              <div>
                <p class="item-title">${escapeHtml(summaryTypeLabel(summary.type))} · ${escapeHtml(recordDate(summary.recordId))}</p>
                <p class="item-desc">${escapeHtml(summary.content.slice(0, 180))}${summary.content.length > 180 ? "..." : ""}</p>
              </div>
              <div class="button-row" style="margin-top:0;">
                <button class="btn ghost" data-copy-summary="${summary.id}">复制</button>
                <button class="btn ghost danger" data-delete-summary="${summary.id}">删除</button>
              </div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function bindPage(route) {
  if (route === "dashboard") bindDashboard();
  if (route === "record") bindRecord();
  if (route === "summary") bindSummary();
  if (route === "tasks") bindTasks();
  if (route === "projects") bindProjects();
  if (route === "history") bindHistory();
  if (route === "preferences") bindPreferences();
}

function bindDashboard() {
  document.querySelectorAll("[data-quick-summary]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        if (!state.records.length) return showToast("还没有可生成报告的记录。");
        state.ui.summaryType = button.dataset.quickSummary;
        const targetId = summaryTargetRecordId(state.ui.summaryType);
        const generated = await generateSummaryDraft(targetId, state.ui.summaryType);
        summaryDraft = { recordId: generated.recordId || targetId, type: state.ui.summaryType, content: generated.content };
        notifyAIMode(generated._meta);
        saveState();
        location.hash = "summary";
      });
    });
  });
  document.querySelectorAll("[data-open-record]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.historyDate = button.dataset.openRecord;
      saveState();
      location.hash = "history";
    });
  });
  document.getElementById("dash-voice")?.addEventListener("click", () => {
    toggleVoiceInput("dash-input", {
      statusId: "dash-voice-status",
      activeLabel: "正在听写...",
      idleLabel: "00:00"
    });
  });
  document.getElementById("dash-organize")?.addEventListener("click", () => {
    handleAsync(async () => {
      const raw = document.getElementById("dash-input").value.trim();
      if (!raw) return showToast("先输入一段工作记录。");
      draftRecord = await parseRecordInput(raw);
      await saveRecordFromObject(draftRecord);
      notifyAIMode(draftRecord._meta);
      showToast("已整理并保存到今日记录。");
      location.hash = "record";
    });
  });
  document.getElementById("dash-polish")?.addEventListener("click", () => {
    handleAsync(() => polishInputText("dash-input"));
  });
  document.getElementById("dash-save-project")?.addEventListener("click", () => {
    handleAsync(async () => {
      const name = document.getElementById("dash-project-name").value.trim();
      const startDate = document.getElementById("dash-project-start").value || todayISO();
      if (!name) return showToast("先输入项目名称。");
      const payload = await saveProject({
        userId: state.user.id,
        name,
        description: "从首页项目快录创建",
        status: "进行中",
        startDate,
        endDate: ""
      });
      applyRemoteState(payload.state);
      showToast("项目已创建，后续语音记录会尝试自动关联。");
      render();
    });
  });
}

function handleAsync(work) {
  Promise.resolve()
    .then(work)
    .catch((error) => {
      console.error(error);
      showToast(error.message || "操作失败，请稍后重试。");
    });
}

function bindRecord() {
  const organize = () => {
    handleAsync(async () => {
      const raw = document.getElementById("record-raw").value.trim();
      if (!raw) return showToast("先输入一段工作记录。");
      draftRecord = await parseRecordInput(raw);
      render();
      notifyAIMode(draftRecord._meta);
    });
  };
  document.getElementById("voice-placeholder")?.addEventListener("click", () => {
    toggleVoiceInput("record-raw", {
      buttonId: "voice-placeholder",
      activeLabel: "◎ 停止听写",
      idleLabel: "◎ 语音输入"
    });
  });
  document.getElementById("polish-record-text")?.addEventListener("click", () => {
    handleAsync(() => polishInputText("record-raw"));
  });
  document.getElementById("polish-record-bottom")?.addEventListener("click", () => {
    handleAsync(() => polishInputText("record-raw"));
  });
  document.getElementById("organize-record")?.addEventListener("click", organize);
  document.getElementById("organize-record-bottom")?.addEventListener("click", organize);
  document.getElementById("load-example")?.addEventListener("click", () => {
    document.getElementById("record-raw").value =
      "今天上午和设计沟通了宣传册修改，下午整理了播客选题，科学北极星发布会视频脚本还需要明天继续改。今天感觉项目内容有点散，后面需要按优先级整理。";
  });
  document.getElementById("save-record")?.addEventListener("click", () => {
    handleAsync(async () => {
      const raw = document.getElementById("record-raw").value.trim();
      const record = buildRecordFromEditor(raw);
      await saveRecordFromObject(record);
      draftRecord = record;
      showToast("今日记录已保存，相关明日待办已同步。");
      render();
    });
  });
}

function bindSummary() {
  document.querySelectorAll("[data-summary-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.summaryTab;
      state.ui.summaryType = type;
      saveState();
      render();
    });
  });
  document.getElementById("auto-daily-summary")?.addEventListener("click", () => {
    handleAsync(async () => {
      const record = getTodayRecord();
      if (!record) return showToast("今天还没有结构化记录。");
      const generated = await generateSummaryDraft(record.id, "daily");
      await persistSummary(record.id, "daily", generated.content);
      notifyAIMode(generated._meta);
      showToast("今日日报已自动生成并保存。");
      render();
    });
  });
  document.getElementById("generate-summary")?.addEventListener("click", () => {
    handleAsync(async () => {
      if (!state.records.length) return showToast("还没有可生成报告的记录。");
      const targetId = summaryTargetRecordId(state.ui.summaryType);
      const generated = await generateSummaryDraft(targetId, state.ui.summaryType);
      summaryDraft = { recordId: generated.recordId || targetId, type: state.ui.summaryType, content: generated.content };
      document.getElementById("summary-output").value = generated.content;
      notifyAIMode(generated._meta);
      showToast("文本已生成，编辑确认后可保存。");
    });
  });
  document.getElementById("save-summary")?.addEventListener("click", () => {
    handleAsync(async () => {
      const recordId = summaryDraft?.recordId || summaryTargetRecordId(state.ui.summaryType);
      if (!recordId) return showToast("还没有可保存的报告对象。");
      const content = document.getElementById("summary-output").value.trim();
      if (!content) return showToast("生成结果为空。");
      const payload = await persistSummary(recordId, state.ui.summaryType, content);
      applyRemoteState(payload.state);
      summaryDraft = null;
      render();
      showToast("总结已保存。");
    });
  });
  document.getElementById("copy-summary")?.addEventListener("click", async () => {
    const content = document.getElementById("summary-output").value;
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      showToast("已复制到剪贴板。");
    } catch {
      showToast("当前浏览器不允许自动复制，可以手动选中文本复制。");
    }
  });
  document.querySelectorAll("[data-copy-summary]").forEach((button) => {
    button.addEventListener("click", () => copySummaryById(button.dataset.copySummary));
  });
  document.querySelectorAll("[data-delete-summary]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        if (!confirm("确定删除这条总结吗？删除后不可恢复。")) return;
        const payload = await deleteSummaryById(button.dataset.deleteSummary);
        applyRemoteState(payload);
        showToast("总结已删除。");
        render();
      });
    });
  });
}

function bindTasks() {
  document.getElementById("filter-status")?.addEventListener("change", (event) => {
    state.ui.taskFilterStatus = event.target.value;
    saveState();
    render();
  });
  document.getElementById("filter-priority")?.addEventListener("change", (event) => {
    state.ui.taskFilterPriority = event.target.value;
    saveState();
    render();
  });
  document.getElementById("filter-date")?.addEventListener("change", (event) => {
    state.ui.taskFilterDate = event.target.value;
    saveState();
    render();
  });
  document.getElementById("clear-task-filter")?.addEventListener("click", () => {
    state.ui.taskFilterStatus = "全部";
    state.ui.taskFilterPriority = "全部";
    state.ui.taskFilterDate = "全部";
    saveState();
    render();
  });
  document.getElementById("add-task")?.addEventListener("click", () => {
    document.getElementById("task-form").style.display = "block";
  });
  document.getElementById("cancel-task")?.addEventListener("click", () => {
    render();
  });
  document.getElementById("save-task")?.addEventListener("click", (event) => {
    handleAsync(async () => {
      const editId = event.target.dataset.editId;
      const task = readTaskForm(editId);
      if (!task.title) return showToast("待办标题不能为空。");
      const payload = editId ? await apiPut(`/tasks/${editId}`, task) : await apiPost("/tasks", task);
      applyRemoteState(payload.state);
      showToast("待办已保存。");
      render();
    });
  });
  document.querySelectorAll("[data-complete-task]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        const task = state.tasks.find((item) => item.id === button.dataset.completeTask);
        if (!task) return;
        const payload = await apiPut(`/tasks/${task.id}`, { ...task, status: "已完成" });
        applyRemoteState(payload.state);
        showToast("已标记完成。");
        render();
      });
    });
  });
  document.querySelectorAll("[data-delete-task]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        if (!confirm("确定删除这个待办吗？删除后不可恢复。")) return;
        const payload = await apiDelete(`/tasks/${button.dataset.deleteTask}`);
        applyRemoteState(payload);
        showToast("待办已删除。");
        render();
      });
    });
  });
  document.querySelectorAll("[data-edit-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.tasks.find((item) => item.id === button.dataset.editTask);
      document.getElementById("task-form").innerHTML = renderTaskForm(task);
      document.getElementById("task-form").style.display = "block";
      bindTasks();
    });
  });
}

function bindProjects() {
  document.querySelectorAll("[data-project-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.selectedProjectId = button.dataset.projectId;
      saveState();
      render();
    });
  });
  document.getElementById("save-project")?.addEventListener("click", () => {
    handleAsync(async () => {
      const name = document.getElementById("project-name").value.trim();
      if (!name) return showToast("项目名称不能为空。");
      const project = {
        id: state.ui.editProjectId || "",
        userId: state.user.id,
        name,
        description: document.getElementById("project-desc").value.trim(),
        status: document.getElementById("project-status").value,
        startDate: document.getElementById("project-start").value || todayISO(),
        endDate: document.getElementById("project-status").value === "已完成"
          ? (document.getElementById("project-end").value || todayISO())
          : document.getElementById("project-end").value
      };
      const payload = await saveProject(project);
      applyRemoteState(payload.state);
      state.ui.selectedProjectId = payload.project.id;
      state.ui.editProjectId = "";
      if (project.status === "已完成") {
        const reviewPayload = await generateProjectReview(payload.project.id);
        applyRemoteState(reviewPayload.state);
        notifyAIMode(reviewPayload._meta);
        showToast("项目已归档，并自动生成项目复盘。");
      } else {
        showToast(project.id ? "项目已更新。" : "项目已创建。");
      }
      saveState();
      render();
    });
  });
  document.getElementById("cancel-project-edit")?.addEventListener("click", () => {
    state.ui.editProjectId = "";
    saveState();
    render();
  });
  document.querySelectorAll("[data-edit-project]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.editProjectId = button.dataset.editProject;
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-close-project]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        const project = state.projects.find((item) => item.id === button.dataset.closeProject);
        if (!project) return;
        if (!confirm("确定关闭并归档这个项目吗？系统会填写今天为收尾日期，并自动生成项目复盘。")) return;
        const payload = await saveProject({ ...project, status: "已完成", endDate: todayISO() });
        applyRemoteState(payload.state);
        const reviewPayload = await generateProjectReview(payload.project.id);
        applyRemoteState(reviewPayload.state);
        notifyAIMode(reviewPayload._meta);
        showToast("项目已归档，项目复盘已生成。");
        render();
      });
    });
  });
  document.querySelectorAll("[data-delete-project]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        if (!confirm("确定删除这个项目吗？关联待办会取消项目关联，历史记录不会删除。")) return;
        const payload = await apiDelete(`/projects/${button.dataset.deleteProject}`);
        applyRemoteState(payload);
        state.ui.selectedProjectId = state.projects[0]?.id || "";
        state.ui.editProjectId = "";
        saveState();
        showToast("项目已删除。");
        render();
      });
    });
  });
  document.querySelectorAll("[data-copy-summary]").forEach((button) => {
    button.addEventListener("click", () => copySummaryById(button.dataset.copySummary));
  });
  document.querySelectorAll("[data-delete-summary]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        if (!confirm("确定删除这条总结吗？删除后不可恢复。")) return;
        const payload = await deleteSummaryById(button.dataset.deleteSummary);
        applyRemoteState(payload);
        showToast("总结已删除。");
        render();
      });
    });
  });
  document.querySelectorAll("[data-delete-record]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        if (!confirm("确定删除这条工作记录吗？关联总结会一起删除，待办会保留但取消来源记录。")) return;
        const payload = await deleteRecordById(button.dataset.deleteRecord);
        applyRemoteState(payload);
        state.ui.expandedRecordId = "";
        saveState();
        showToast("工作记录已删除。");
        render();
      });
    });
  });
}

function bindHistory() {
  const sync = () => {
    state.ui.historyDate = document.getElementById("history-date").value;
    state.ui.historyKeyword = document.getElementById("history-keyword").value;
    state.ui.historyProject = document.getElementById("history-project").value;
    saveState();
    render();
  };
  document.getElementById("history-date")?.addEventListener("change", sync);
  document.getElementById("history-keyword")?.addEventListener("input", debounce(sync, 300));
  document.getElementById("history-project")?.addEventListener("change", sync);
  document.getElementById("clear-history-filter")?.addEventListener("click", () => {
    state.ui.historyDate = "";
    state.ui.historyKeyword = "";
    state.ui.historyProject = "全部";
    saveState();
    render();
  });
  document.querySelectorAll("[data-open-record]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.historyDate = button.dataset.openRecord;
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-toggle-record]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.expandedRecordId = state.ui.expandedRecordId === button.dataset.toggleRecord ? "" : button.dataset.toggleRecord;
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-copy-summary]").forEach((button) => {
    button.addEventListener("click", () => copySummaryById(button.dataset.copySummary));
  });
  document.querySelectorAll("[data-delete-summary]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        if (!confirm("确定删除这条总结吗？删除后不可恢复。")) return;
        const payload = await deleteSummaryById(button.dataset.deleteSummary);
        applyRemoteState(payload);
        showToast("总结已删除。");
        render();
      });
    });
  });
  document.querySelectorAll("[data-delete-record]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAsync(async () => {
        if (!confirm("确定删除这条工作记录吗？关联总结会一起删除，待办会保留但取消来源记录。")) return;
        const payload = await deleteRecordById(button.dataset.deleteRecord);
        applyRemoteState(payload);
        state.ui.expandedRecordId = "";
        saveState();
        showToast("工作记录已删除。");
        render();
      });
    });
  });
}

function bindPreferences() {
  document.getElementById("refresh-ai-status")?.addEventListener("click", () => {
    handleAsync(async () => {
      await refreshAIStatus(true);
      render();
    });
  });
  document.getElementById("refresh-speech-status")?.addEventListener("click", () => {
    handleAsync(async () => {
      await refreshSpeechStatus(true);
      render();
    });
  });
  document.getElementById("test-ai")?.addEventListener("click", () => {
    handleAsync(async () => {
      const result = await apiPost("/ai/test", {});
      if (result.ok) {
        showToast("DeepSeek 测试成功。");
      } else {
        showToast(`AI 测试未通过：${result.error || "请检查环境变量"}`);
      }
      await refreshAIStatus(false);
      render();
    });
  });
  document.getElementById("save-preferences")?.addEventListener("click", () => {
    handleAsync(async () => {
      const preferences = { ...state.preferences };
      document.querySelectorAll("[data-pref]").forEach((field) => {
        preferences[field.dataset.pref] = field.value.trim();
      });
      const payload = await apiPut("/preferences", preferences);
      applyRemoteState(payload.state);
      showToast("个人定制配置已保存，并会参与 mock 总结生成。");
      render();
    });
  });
}

async function copySummaryById(summaryId) {
  const summary = state.summaries.find((item) => item.id === summaryId);
  if (!summary) return showToast("没有找到可复制的总结。");
  try {
    await navigator.clipboard.writeText(summary.content);
    showToast("总结已复制到剪贴板。");
  } catch {
    showToast("当前浏览器不允许自动复制，可以手动选中文本复制。");
  }
}

function buildRecordFromEditor(rawInput) {
  const source = draftRecord || getTodayRecord() || {};
  const record = {
    id: getTodayRecord()?.id || draftRecord?.id || uid("record"),
    userId: state.user.id,
    date: todayISO(),
    rawInput,
    createdAt: getTodayRecord()?.createdAt || nowISO(),
    updatedAt: nowISO()
  };
  categories.forEach(([key]) => {
    const field = document.getElementById(`field-${key}`);
    record[key] = field ? linesFromTextarea(field.value) : uniqueClean(source[key] || []);
  });
  return record;
}

async function saveRecordFromObject(record) {
  return withApiFallback(
    async () => {
      const payload = await apiPost("/records", { record });
      applyRemoteState(payload.state);
      return payload.record;
    },
    () => {
      ensureRelatedProjects(record.relatedProjects || []);
      const index = state.records.findIndex((item) => item.date === record.date);
      if (index >= 0) state.records[index] = { ...state.records[index], ...record, updatedAt: nowISO() };
      else state.records.unshift(record);
      syncTasksFromRecord(record);
      saveState();
      return record;
    }
  );
}

function syncTasksFromRecord(record) {
  const existingTitles = new Set(state.tasks.map((task) => task.title));
  record.tomorrowTasks.forEach((title) => {
    if (existingTitles.has(title)) return;
    state.tasks.unshift({
      id: uid("task"),
      userId: state.user.id,
      title,
      description: "从快速记录自动提取",
      status: "未开始",
      priority: inferPriority(title),
      dueDate: tomorrowISO(),
      relatedProjectId: projectIdByName(record.relatedProjects[0]),
      sourceRecordId: record.id,
      createdAt: nowISO(),
      updatedAt: nowISO()
    });
  });
}

function readTaskForm(editId = "") {
  const previous = state.tasks.find((task) => task.id === editId);
  return {
    id: editId || uid("task"),
    userId: state.user.id,
    title: document.getElementById("task-title").value.trim(),
    description: document.getElementById("task-desc").value.trim(),
    status: document.getElementById("task-status").value,
    priority: document.getElementById("task-priority").value,
    dueDate: document.getElementById("task-due").value,
    relatedProjectId: document.getElementById("task-project").value,
    sourceRecordId: previous?.sourceRecordId || "",
    createdAt: previous?.createdAt || nowISO(),
    updatedAt: nowISO()
  };
}

function aiOrganize(rawInput) {
  const record = {
    id: getTodayRecord()?.id || uid("record"),
    userId: state.user.id,
    date: todayISO(),
    rawInput,
    completedItems: [],
    ongoingItems: [],
    tomorrowTasks: [],
    projectProgress: [],
    risks: [],
    reflections: [],
    followUpPeople: [],
    relatedProjects: [],
    uncategorizedItems: [],
    createdAt: getTodayRecord()?.createdAt || nowISO(),
    updatedAt: nowISO()
  };
  const sentences = splitSentences(rawInput);
  sentences.forEach((sentence) => {
    const text = cleanup(sentence);
    if (!text) return;
    const hasTomorrow = /明天|下周|后续|接下来|继续|待|需要/.test(sentence);
    const hasDone = /完成|整理|沟通|对齐|提交|发布|修复|处理|写了|做了|确认|推进了|参加/.test(sentence);
    const hasRisk = /问题|风险|卡点|阻塞|延期|不确定|缺少|还没|有点散|较散|依赖|困难/.test(sentence);
    const hasReflection = /感觉|复盘|反思|想到|建议|需要按|改进|以后|后面/.test(sentence);
    const hasProject = /项目|发布会|活动|系统|产品|版本|客户|合同|脚本|选题|宣传册/.test(sentence);

    if (hasDone && !hasTomorrow && !hasRisk) record.completedItems.push(text);
    if (hasTomorrow) record.tomorrowTasks.push(removeFuturePrefix(text));
    if (/继续|进行中|推进|跟进|还需要|待/.test(sentence)) record.ongoingItems.push(removeFuturePrefix(text));
    if (hasProject && (hasDone || hasTomorrow)) {
      record.projectProgress.push(toProjectProgress(hasTomorrow ? removeFuturePrefix(text) : text));
    }
    if (hasRisk) record.risks.push(text);
    if (hasReflection) record.reflections.push(text);
    extractPeople(sentence).forEach((person) => addUnique(record.followUpPeople, person));
    extractProjects(sentence).forEach((project) => addUnique(record.relatedProjects, project));
    if (!hasDone && !hasTomorrow && !hasRisk && !hasReflection && !hasProject) record.uncategorizedItems.push(text);
  });

  categories.forEach(([key]) => {
    record[key] = uniqueClean(record[key]);
  });
  if (!record.relatedProjects.length) {
    const prefProjects = state.preferences.keyProjects
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    record.relatedProjects = prefProjects.slice(0, 2);
  }
  return record;
}

function generateSummary(record, type) {
  if (type === "weekly") {
    return [
      `【周报】${record.rangeLabel ? `（${record.rangeLabel}）` : ""}`,
      `本周共记录 ${record.recordCount || 1} 天工作，主要围绕${record.relatedProjects.slice(0, 3).join("、") || "重点工作"}推进。`,
      "",
      "1. 本周完成：",
      ...asBullets(record.completedItems),
      "",
      "2. 进行中事项：",
      ...asBullets(record.ongoingItems),
      "",
      "3. 下周待办：",
      ...asBullets(record.tomorrowTasks),
      "",
      "4. 风险与复盘：",
      ...asBullets([...(record.risks || []), ...(record.reflections || [])])
    ].join("\n");
  }
  if (type === "monthly") {
    return [
      `【月报】${record.rangeLabel ? `（${record.rangeLabel}）` : ""}`,
      `本月共记录 ${record.recordCount || 1} 天工作，聚焦${record.relatedProjects.slice(0, 4).join("、") || "重点事项"}。`,
      "",
      "1. 核心成果：",
      ...asBullets(record.completedItems),
      "",
      "2. 项目进展：",
      ...asBullets(record.projectProgress.length ? record.projectProgress : record.ongoingItems),
      "",
      "3. 下月计划：",
      ...asBullets(record.tomorrowTasks),
      "",
      "4. 风险与经验：",
      ...asBullets([...(record.risks || []), ...(record.reflections || [])])
    ].join("\n");
  }
  if (type === "tomorrow") {
    return [
      "【明日工作计划】",
      ...numbered("重点推进", record.tomorrowTasks),
      ...numbered("需持续跟进", record.ongoingItems),
      record.risks.length ? "风险关注：" : "",
      ...record.risks.map((item) => `- ${item}`)
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (type === "leader") {
    return [
      "【今日工作进展汇报】",
      `今日围绕${record.relatedProjects.slice(0, 2).join("、") || "重点工作"}推进，已完成 ${record.completedItems.length} 项事项。`,
      "",
      "1. 关键结果：",
      ...asBullets(record.completedItems),
      "",
      "2. 项目进展：",
      ...asBullets(record.projectProgress),
      "",
      "3. 风险与需支持事项：",
      ...(record.risks.length ? asBullets(record.risks) : ["- 暂无明显风险"]),
      "",
      "4. 下一步计划：",
      ...asBullets(record.tomorrowTasks)
    ].join("\n");
  }
  return [
    "【今日工作总结】",
    "1. 完成事项：",
    ...asBullets(record.completedItems),
    "",
    "2. 项目进展：",
    ...asBullets(record.projectProgress),
    "",
    "3. 问题与风险：",
    ...(record.risks.length ? asBullets(record.risks) : ["- 暂无明显风险"]),
    "",
    "4. 明日计划：",
    ...asBullets(record.tomorrowTasks)
  ].join("\n");
}

function generateProjectReviewText(project) {
  if (!project) return "";
  const records = state.records.filter((record) => record.relatedProjects.includes(project.name));
  const tasks = state.tasks.filter((task) => task.relatedProjectId === project.id);
  const completed = uniqueClean([
    ...records.flatMap((record) => record.completedItems || []),
    ...tasks.filter((task) => task.status === "已完成").map((task) => task.title)
  ]);
  const ongoing = uniqueClean([
    ...records.flatMap((record) => record.ongoingItems || []),
    ...tasks.filter((task) => task.status !== "已完成").map((task) => task.title)
  ]);
  const risks = uniqueClean(records.flatMap((record) => record.risks || []));
  const reflections = uniqueClean(records.flatMap((record) => record.reflections || []));
  return [
    `【项目复盘】${project.name}`,
    `项目周期：${project.startDate || "未填写"} 至 ${project.endDate || todayISO()}`,
    "",
    "1. 项目成果：",
    ...asBullets(completed),
    "",
    "2. 推进过程：",
    ...asBullets(ongoing),
    "",
    "3. 问题与风险：",
    ...asBullets(risks),
    "",
    "4. 经验与改进：",
    ...asBullets(reflections)
  ].join("\n");
}

function upsertSummary(recordId, type, content) {
  const index = state.summaries.findIndex((summary) => summary.recordId === recordId && summary.type === type);
  const summary = {
    id: index >= 0 ? state.summaries[index].id : uid("summary"),
    userId: state.user.id,
    recordId,
    type,
    content,
    createdAt: index >= 0 ? state.summaries[index].createdAt : nowISO(),
    updatedAt: nowISO()
  };
  if (index >= 0) state.summaries[index] = summary;
  else state.summaries.unshift(summary);
}

function findLatestSummary(type, recordId) {
  if (!recordId) return null;
  return state.summaries.find((summary) => summary.type === type && summary.recordId === recordId) || null;
}

async function polishInputText(targetId, options = {}) {
  const target = document.getElementById(targetId);
  if (!target) return showToast("没有找到可润色的输入框。");
  const text = target.value.trim();
  if (!text) return showToast("先输入或录入一段内容。");
  const result = await polishTextDraft(text);
  if (result.text) {
    target.value = result.text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    notifyAIMode(result._meta);
    showToast(options.successMessage || "文本已润色。");
  }
}

function polishTextLocal(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/(嗯|呃|额|啊|诶|那个|这个|就是|就是说|然后呢|然后|其实|反正|怎么说呢|我觉得吧|大概就是)/g, "")
    .replace(/([，。！？；、])\1+/g, "$1")
    .replace(/([，；、])([。！？])/g, "$2")
    .replace(/^[，。！？；、]+|[，；、]+$/g, "")
    .trim();
}

function buildPeriodRecord(type, anchorDate = todayISO()) {
  const range = periodRange(type, anchorDate);
  const records = state.records
    .filter((record) => record.date >= range.start && record.date <= range.end)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!records.length) return null;
  const record = {
    id: summaryTargetRecordId(type, anchorDate),
    userId: state.user.id,
    date: range.end,
    rawInput: records.map((item) => `${item.date}：${item.rawInput}`).join("\n"),
    createdAt: records[0].createdAt,
    updatedAt: nowISO(),
    rangeLabel: `${range.start} 至 ${range.end}`,
    recordCount: records.length
  };
  categories.forEach(([key]) => {
    record[key] = uniqueClean(records.flatMap((item) => item[key] || []));
  });
  return record;
}

function summaryTargetRecordId(type, anchorDate = todayISO()) {
  if (type === "weekly" || type === "monthly") {
    const range = periodRange(type, anchorDate);
    return `period_${type}_${range.start}_${range.end}`;
  }
  return getTodayRecord()?.id || "";
}

function periodRange(type, anchorDate = todayISO()) {
  const date = new Date(`${anchorDate}T00:00:00`);
  if (type === "monthly") {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { start: dateInput(start), end: dateInput(end) };
  }
  const day = date.getDay() || 7;
  const start = new Date(date);
  start.setDate(date.getDate() - day + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: dateInput(start), end: dateInput(end) };
}

function dateInput(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function periodSummaryHint(type) {
  const range = periodRange(type, todayISO());
  const count = state.records.filter((record) => record.date >= range.start && record.date <= range.end).length;
  return `${summaryTypeLabel(type)}范围：${range.start} 至 ${range.end}，当前可聚合 ${count} 天记录。`;
}

function splitSentences(input) {
  return input
    .replace(/\n+/g, "。")
    .split(/[，,。！？!?；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanup(text) {
  return text
    .replace(/^(今天|上午|下午|晚上|中午|早上|然后|另外|还有|目前|当前)/, "")
    .replace(/^(今天)?(上午|下午|晚上|中午|早上)/, "")
    .replace(/^(风险是|问题是|卡点是)/, "")
    .replace(/^和/, "与")
    .trim();
}

function removeFuturePrefix(text) {
  return text
    .replace(/^(明天继续|明天|下周|后续|接下来|还需要|需要|继续|待)/, "")
    .replace(/还需要明天继续/g, "继续")
    .trim();
}

function toProjectProgress(text) {
  if (text.includes("：")) return text;
  const project = extractProjects(text)[0] || "相关项目";
  return `${project}：${text}`;
}

function extractPeople(sentence) {
  const people = [];
  const patterns = [/和([^，。；、]+?)沟通/g, /与([^，。；、]+?)沟通/g, /跟(?!进)([^，。；、]+?)(沟通|对齐|确认|跟进)/g];
  patterns.forEach((pattern) => {
    let match = pattern.exec(sentence);
    while (match) {
      const person = match[1].replace(/了$/, "").trim();
      if (person && !person.startsWith("进")) people.push(person);
      match = pattern.exec(sentence);
    }
  });
  return people.filter(Boolean);
}

function extractProjects(sentence) {
  const projects = [];
  state.projects.forEach((project) => {
    if (sentence.includes(project.name)) projects.push(project.name);
  });
  const known = state.preferences.keyProjects
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  known.forEach((project) => {
    if (sentence.includes(project)) projects.push(project);
  });
  if (projects.length) return projects;
  [/([\u4e00-\u9fa5A-Za-z0-9]{2,12}项目)/g, /([\u4e00-\u9fa5A-Za-z0-9]{2,12}发布会)/g, /(播客选题)/g, /(宣传册)/g].forEach((pattern) => {
    let match = pattern.exec(sentence);
    while (match) {
      const cleaned = match[1].replace(/^(今天|明天|继续|跟进|推进|完成|整理|对齐)/, "").trim();
      if (cleaned.length >= 2) projects.push(cleaned);
      match = pattern.exec(sentence);
    }
  });
  return projects;
}

function ensureRelatedProjects(names) {
  names.filter(Boolean).forEach((name) => {
    if (projectIdByName(name)) return;
    state.projects.push({
      id: uid("project"),
      userId: state.user.id,
      name,
      description: "由快速记录自动识别创建",
      status: "进行中",
      startDate: todayISO(),
      endDate: "",
      createdAt: nowISO(),
      updatedAt: nowISO()
    });
  });
}

function projectTasksById(projectId) {
  return state.tasks.filter((task) => task.relatedProjectId === projectId);
}

function projectIdByName(name) {
  const project = state.projects.find((item) => item.name === name);
  return project?.id || "";
}

function projectName(projectId) {
  return state.projects.find((project) => project.id === projectId)?.name || "未关联项目";
}

function recordDate(recordId) {
  const period = String(recordId || "").match(/^period_(weekly|monthly)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/);
  if (period) return `${period[2]} 至 ${period[3]}`;
  const project = String(recordId || "").match(/^project_(.+)$/);
  if (project) {
    const item = state.projects.find((entry) => entry.id === project[1]);
    return item ? `${item.name} · ${item.startDate || "未填开始"} 至 ${item.endDate || "进行中"}` : "项目复盘";
  }
  return state.records.find((record) => record.id === recordId)?.date || "未知记录";
}

function inferPriority(title) {
  if (/风险|紧急|今天|明天|审批|发布|客户/.test(title)) return "高";
  if (/整理|优化|跟进|确认/.test(title)) return "中";
  return "低";
}

function summaryTypeLabel(type) {
  return {
    daily: "日报",
    tomorrow: "明日计划",
    leader: "领导汇报版",
    weekly: "周报",
    monthly: "月报",
    project: "项目复盘",
    review: "个人复盘"
  }[type] || "周报";
}

function numbered(title, items) {
  if (!items.length) return [`${title}：`, "- 暂无"];
  return [`${title}：`, ...items.map((item, index) => `${index + 1}. ${item}`)];
}

function asBullets(items) {
  return items.length ? items.map((item) => `- ${item}`) : ["- 暂无"];
}

function linesFromTextarea(value) {
  return value
    .split("\n")
    .map((line) => line.trim().replace(/^- /, ""))
    .filter(Boolean);
}

function uniqueClean(items) {
  return [...new Set((items || []).map((item) => item.trim()).filter(Boolean))];
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function priorityClass(priority) {
  if (priority === "高") return "high";
  if (priority === "中") return "medium";
  return "low";
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function toggleVoiceInput(targetId, options = {}) {
  if (voiceSession?.targetId === targetId) {
    stopVoiceInput("语音输入已停止。");
    return;
  }
  if (voiceSession) stopVoiceInput();

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    startRecorderTranscription(targetId, options, "当前浏览器不支持内置语音识别，已尝试后端录音转写。");
    return;
  }

  const target = document.getElementById(targetId);
  if (!target) {
    showToast("没有找到可写入的输入框。");
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  voiceSession = {
    targetId,
    recognition,
    finalText: "",
    baseValue: target.value,
    options,
    startedAt: Date.now(),
    timer: null,
    manualStop: false
  };

  recognition.onstart = () => {
    updateVoiceUI(true);
    showToast("语音输入已开始，说完后可以再点一次停止。");
  };

  recognition.onresult = (event) => {
    if (!voiceSession || voiceSession.recognition !== recognition) return;
    let interimText = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) {
        voiceSession.finalText = joinSpeechText(voiceSession.finalText, transcript);
      } else {
        interimText = joinSpeechText(interimText, transcript);
      }
    }
    writeVoiceText(voiceSession.finalText, interimText);
  };

  recognition.onerror = (event) => {
    const message = voiceErrorMessage(event.error);
    if (event.error === "network") {
      stopVoiceInput("", { keepText: true, skipStop: true });
      startRecorderTranscription(targetId, options, message);
      return;
    }
    stopVoiceInput(message, { keepText: true });
  };

  recognition.onend = () => {
    if (!voiceSession || voiceSession.recognition !== recognition) return;
    const hadText = Boolean(voiceSession.finalText.trim());
    stopVoiceInput(hadText ? "语音内容已写入输入框。" : "未识别到语音内容。", { skipStop: true, keepText: true });
  };

  try {
    recognition.start();
  } catch (error) {
    voiceSession = null;
    showToast(error.message || "语音输入启动失败。");
  }
}

async function startRecorderTranscription(targetId, options = {}, reason = "") {
  if (!speechStatus && apiAvailable) await refreshSpeechStatus(false);
  if (!speechStatus?.enabled) {
    showToast(`${reason || "浏览器语音识别不可用"} 当前没有可用的语音转文字服务，请配置 BAIDU_API_KEY/BAIDU_SECRET_KEY 或 STT_API_KEY。`);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext && !window.webkitAudioContext) {
    showToast("当前浏览器不支持录音上传转写，请使用 Chrome、Edge 或 Safari 新版浏览器。");
    return;
  }
  const target = document.getElementById(targetId);
  if (!target) return showToast("没有找到可写入的输入框。");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const samples = [];
    processor.onaudioprocess = (event) => {
      samples.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(audioContext.destination);

    voiceSession = {
      type: "recorder",
      targetId,
      audioContext,
      processor,
      source,
      stream,
      samples,
      baseValue: target.value,
      options,
      startedAt: Date.now(),
      timer: null
    };
    updateVoiceUI(true);
    showToast(`${reason ? `${reason} ` : ""}已开始录音，讲完后再点一次停止转写。`);
  } catch (error) {
    voiceSession = null;
    showToast(error.name === "NotAllowedError" ? "浏览器未获得麦克风权限，请允许后重试。" : error.message || "录音启动失败。");
  }
}

function stopVoiceInput(message = "", options = {}) {
  if (!voiceSession) return;
  const session = voiceSession;
  if (session.type === "recorder") {
    voiceSession = null;
    clearInterval(session.timer);
    updateVoiceUI(false, session);
    session.processor.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    handleAsync(async () => {
      if (!session.samples.length) return showToast("没有录到音频内容。");
      showToast("正在转写语音...");
      await session.audioContext.close();
      const wavBlob = encodeWavBlob(session.samples, session.audioContext.sampleRate, 16000);
      const result = await apiPostAudio("/speech/transcribe", wavBlob);
      const field = document.getElementById(session.targetId);
      if (field && result.text) field.value = joinSpeechText(session.baseValue, result.text);
      if (field && result.text) await polishInputText(session.targetId, { successMessage: "语音已转成文字并完成润色。" });
      else showToast("语音已转成文字。");
    });
    if (message) showToast(message);
    return;
  }
  voiceSession = null;
  clearInterval(session.timer);
  if (!options.skipStop) {
    try {
      session.manualStop = true;
      session.recognition.stop();
    } catch {
      // Browser may already have ended the recognition session.
    }
  }
  updateVoiceUI(false, session);
  if (session.finalText?.trim()) {
    handleAsync(() => polishInputText(session.targetId, { successMessage: "语音内容已写入并完成润色。" }));
  }
  if (message) showToast(message);
}

async function apiPostAudio(path, blob) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob
  });
  return parseApiResponse(response);
}

function writeVoiceText(finalText, interimText) {
  if (!voiceSession) return;
  const target = document.getElementById(voiceSession.targetId);
  if (!target) return;
  const speechText = joinSpeechText(finalText, interimText);
  target.value = joinSpeechText(voiceSession.baseValue, speechText);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

function updateVoiceUI(active, endedSession = null) {
  const session = voiceSession || endedSession;
  if (!session) return;
  const target = document.getElementById(session.targetId);
  const button = session.options.buttonId ? document.getElementById(session.options.buttonId) : null;
  const status = session.options.statusId ? document.getElementById(session.options.statusId) : null;
  target?.classList.toggle("voice-active", active);
  button?.classList.toggle("listening", active);
  if (button) button.textContent = active ? session.options.activeLabel : session.options.idleLabel;
  if (status) status.textContent = active ? session.options.activeLabel : session.options.idleLabel;
  if (active) {
    clearInterval(session.timer);
    session.timer = setInterval(() => {
      if (!voiceSession || voiceSession !== session) return;
      const elapsed = Date.now() - session.startedAt;
      if (status) status.textContent = `${formatVoiceDuration(elapsed)} / ${formatVoiceDuration(VOICE_MAX_DURATION_MS)} · 正在听写`;
      if (elapsed >= VOICE_MAX_DURATION_MS) {
        stopVoiceInput("已达到单次语音输入时长上限，正在处理内容。");
      }
    }, 500);
  }
}

function joinSpeechText(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}${/[。！？!?；;，,]$/.test(a) ? "" : "。"}${b}`;
}

function formatVoiceDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function voiceErrorMessage(error) {
  return {
    "not-allowed": "浏览器未获得麦克风权限，请允许后重试。",
    "service-not-allowed": "浏览器阻止了语音识别服务，请检查权限设置。",
    "no-speech": "没有检测到语音，可以靠近麦克风后重试。",
    "audio-capture": "没有检测到可用麦克风。",
    network: "浏览器在线语音识别网络不可用。",
    aborted: "语音输入已取消。"
  }[error] || "语音输入中断，请重试。";
}

function encodeWavBlob(chunks, inputSampleRate, outputSampleRate = 16000) {
  const samples = mergeAudioChunks(chunks);
  const resampled = downsampleBuffer(samples, inputSampleRate, outputSampleRate);
  const buffer = new ArrayBuffer(44 + resampled.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + resampled.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputSampleRate, true);
  view.setUint32(28, outputSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, resampled.length * 2, true);
  let offset = 44;
  for (const sample of resampled) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

function mergeAudioChunks(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return buffer;
  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), buffer.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += buffer[j];
    result[i] = sum / Math.max(1, end - start);
  }
  return result;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  toastTimer = setTimeout(() => toast.remove(), 2600);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
