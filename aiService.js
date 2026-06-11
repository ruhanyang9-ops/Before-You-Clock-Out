const categories = [
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

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 12000;

function getAIConfig() {
  const provider = process.env.AI_PROVIDER || "deepseek";
  const apiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || "";
  const baseUrl = (process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    provider,
    apiKey,
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

function getAIStatus() {
  const config = getAIConfig();
  return {
    enabled: Boolean(config.apiKey),
    provider: config.provider,
    model: config.model,
    baseUrlHost: safeHost(config.baseUrl),
    mode: config.apiKey ? "real" : "mock"
  };
}

async function testAIConnection() {
  if (!getAIConfig().apiKey) {
    return { ok: false, mode: "mock", error: "AI_API_KEY/DEEPSEEK_API_KEY 未配置" };
  }
  try {
    const content = await callDeepSeek(buildParseMessages("今天完成 AI 连接测试，明天继续验证日报生成。", {}), {
      maxTokens: 500,
      responseFormat: { type: "json_object" },
      temperature: 0
    });
    const parsed = parseJsonObject(content);
    const ok = categories.every((key) => Array.isArray(parsed[key]));
    return {
      ok,
      mode: "real",
      message: ok ? "DeepSeek 结构化整理测试通过" : "DeepSeek 返回结构不完整"
    };
  } catch (error) {
    return { ok: false, mode: "mock", error: error.message };
  }
}

function nowISO() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function parseWorkRecord(rawInput, preference = {}, existingRecord = null) {
  const record = {
    id: existingRecord?.id || uid("record"),
    userId: "user_default",
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
    createdAt: existingRecord?.createdAt || nowISO(),
    updatedAt: nowISO()
  };

  splitSentences(rawInput).forEach((sentence) => {
    const text = cleanup(sentence);
    if (!text) return;
    const hasTomorrow = /明天|下周|后续|接下来|继续|待|需要/.test(sentence);
    const hasRisk = /问题|风险|卡点|阻塞|延期|不确定|缺少|还没|有点散|较散|依赖|困难/.test(sentence);
    const hasDone = /完成|整理|沟通|对齐|提交|发布|修复|处理|写了|做了|确认|推进了|参加|联调/.test(sentence);
    const hasReflection = /感觉|复盘|反思|想到|建议|需要按|改进|以后|后面/.test(sentence);
    const hasProject = /项目|发布会|活动|系统|产品|版本|客户|合同|脚本|选题|宣传册|官网|看板/.test(sentence);

    if (hasDone && !hasTomorrow && !hasRisk) record.completedItems.push(text);
    if (hasTomorrow) record.tomorrowTasks.push(removeFuturePrefix(text));
    if (/继续|进行中|推进|跟进|还需要|待/.test(sentence)) record.ongoingItems.push(removeFuturePrefix(text));
    if (hasProject && (hasDone || hasTomorrow)) {
      record.projectProgress.push(toProjectProgress(hasTomorrow ? removeFuturePrefix(text) : text));
    }
    if (hasRisk) record.risks.push(text);
    if (hasReflection) record.reflections.push(text);
    extractPeople(sentence, preference).forEach((person) => addUnique(record.followUpPeople, person));
    extractProjects(sentence, preference).forEach((project) => addUnique(record.relatedProjects, project));
    if (!hasDone && !hasTomorrow && !hasRisk && !hasReflection && !hasProject) {
      record.uncategorizedItems.push(text);
    }
  });

  categories.forEach((key) => {
    record[key] = uniqueClean(record[key]);
  });
  if (!record.relatedProjects.length) {
    record.relatedProjects = splitPreferenceList(preference.keyProjects).slice(0, 2);
  }
  return record;
}

async function parseWorkRecordWithMeta(rawInput, preference = {}, existingRecord = null) {
  if (!getAIConfig().apiKey) {
    return {
      record: parseWorkRecord(rawInput, preference, existingRecord),
      _meta: { aiMode: "mock", fallbackReason: "AI_API_KEY/DEEPSEEK_API_KEY 未配置" }
    };
  }

  try {
    const content = await callDeepSeek(buildParseMessages(rawInput, preference), {
      maxTokens: 1200,
      responseFormat: { type: "json_object" },
      temperature: 0.1
    });
    const parsed = parseJsonObject(content);
    const record = normalizeAIRecord(parsed, rawInput, existingRecord, preference);
    return { record, _meta: { aiMode: "real" } };
  } catch (error) {
    return {
      record: parseWorkRecord(rawInput, preference, existingRecord),
      _meta: { aiMode: "mock", fallbackReason: error.message }
    };
  }
}

function generateDailySummary(record, preference = {}) {
  if (preference.dailyTemplate) {
    return [
      preference.dailyTemplate.trim(),
      "",
      "【今日完成】",
      ...asNumbered(record.completedItems),
      "【项目进展】",
      ...asNumbered(record.projectProgress),
      "【问题与风险】",
      ...asNumbered(record.risks.length ? record.risks : ["暂无明显风险"]),
      "【明日计划】",
      ...asNumbered(record.tomorrowTasks)
    ].join("\n");
  }
  return [
    "【今日工作总结】",
    "一、今日完成",
    ...asNumbered(record.completedItems),
    "二、项目进展",
    ...asNumbered(record.projectProgress),
    "三、问题与风险",
    ...asNumbered(record.risks.length ? record.risks : ["暂无明显风险"]),
    "四、明日计划",
    ...asNumbered(record.tomorrowTasks),
    preference.outputStyle ? `\n输出风格：${preference.outputStyle}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function generateWeeklySummary(record, preference = {}) {
  return [
    `【周报】${record.rangeLabel ? `（${record.rangeLabel}）` : ""}`,
    `本周共记录 ${record.recordCount || 1} 天工作，整体围绕${record.relatedProjects.slice(0, 3).join("、") || "重点工作"}推进。`,
    "",
    "一、本周完成",
    ...asNumbered(record.completedItems),
    "二、进行中事项",
    ...asNumbered(record.ongoingItems.length ? record.ongoingItems : ["暂无持续进行事项"]),
    "三、待办与下周计划",
    ...asNumbered(record.tomorrowTasks.length ? record.tomorrowTasks : ["暂无明确待办"]),
    "四、问题与风险",
    ...asNumbered(record.risks.length ? record.risks : ["暂无明显风险"]),
    "五、复盘与改进",
    ...asNumbered(record.reflections.length ? record.reflections : ["继续保持日记录节奏，提升周度回顾质量"]),
    preference.outputStyle ? `\n输出风格：${preference.outputStyle}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function generateMonthlySummary(record, preference = {}) {
  return [
    `【月报】${record.rangeLabel ? `（${record.rangeLabel}）` : ""}`,
    `本月共记录 ${record.recordCount || 1} 天工作，主要聚焦${record.relatedProjects.slice(0, 4).join("、") || "重点事项"}。`,
    "",
    "一、核心成果",
    ...asNumbered(record.completedItems),
    "二、重点项目进展",
    ...asNumbered(record.projectProgress.length ? record.projectProgress : record.ongoingItems),
    "三、未完成与下月计划",
    ...asNumbered(record.tomorrowTasks.length ? record.tomorrowTasks : ["暂无明确待办"]),
    "四、风险与卡点",
    ...asNumbered(record.risks.length ? record.risks : ["暂无明显风险"]),
    "五、经验复盘",
    ...asNumbered(record.reflections.length ? record.reflections : ["后续可继续沉淀稳定的记录和复盘习惯"]),
    preference.reportAudience ? `\n汇报对象：${preference.reportAudience}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function generateTomorrowPlan(record) {
  return [
    "【明日工作计划】",
    "一、重点推进",
    ...asNumbered(record.tomorrowTasks),
    "二、持续跟进",
    ...asNumbered(record.ongoingItems.length ? record.ongoingItems : ["暂无持续跟进事项"]),
    "三、风险关注",
    ...asNumbered(record.risks.length ? record.risks : ["暂无明显风险"])
  ].join("\n");
}

function generateLeaderReport(record, preference = {}) {
  const audience = preference.reportAudience ? `面向${preference.reportAudience}汇报：` : "";
  const focus = record.relatedProjects.slice(0, 3).join("、") || "重点工作";
  return [
    `${audience}今日主要围绕${focus}事项展开推进。`,
    ...record.completedItems.map((item, index) => `${index + 1}. 在相关事项上，完成了${item}，推动工作进入下一步；`),
    ...record.projectProgress.map((item, index) => `${record.completedItems.length + index + 1}. ${item}。`),
    record.risks.length
      ? `针对${record.risks.join("、")}，已纳入后续重点跟进。`
      : "当前暂无明显阻塞风险。",
    `明日计划重点推进${record.tomorrowTasks.join("、") || "既定事项"}，确保相关事项按节奏落地。`
  ].join("\n");
}

function generateProjectReview(record, preference = {}) {
  return [
    `【项目复盘】${record.relatedProjects[0] || "未命名项目"}`,
    `项目周期：${record.rangeLabel || record.date}`,
    "",
    "一、项目成果",
    ...asNumbered(record.completedItems),
    "二、推进过程",
    ...asNumbered(record.projectProgress.length ? record.projectProgress : record.ongoingItems),
    "三、问题与风险",
    ...asNumbered(record.risks.length ? record.risks : ["暂无明显风险"]),
    "四、经验与改进",
    ...asNumbered(record.reflections.length ? record.reflections : ["后续可继续沉淀项目关键节点和协作经验"]),
    "五、后续待办",
    ...asNumbered(record.tomorrowTasks.length ? record.tomorrowTasks : ["暂无后续待办"]),
    preference.outputStyle ? `\n输出风格：${preference.outputStyle}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function generateSummary(record, type, preference = {}) {
  if (type === "weekly") return generateWeeklySummary(record, preference);
  if (type === "monthly") return generateMonthlySummary(record, preference);
  if (type === "project") return generateProjectReview(record, preference);
  if (type === "tomorrow" || type === "tomorrow_plan") return generateTomorrowPlan(record, preference);
  if (type === "leader" || type === "leader_report") return generateLeaderReport(record, preference);
  return generateDailySummary(record, preference);
}

async function generateSummaryWithMeta(record, type, preference = {}) {
  if (!getAIConfig().apiKey) {
    return {
      content: generateSummary(record, type, preference),
      _meta: { aiMode: "mock", fallbackReason: "AI_API_KEY/DEEPSEEK_API_KEY 未配置" }
    };
  }

  try {
    const content = await callDeepSeek(buildSummaryMessages(record, type, preference), {
      maxTokens: type === "weekly" || type === "monthly" ? 1900 : 1400,
      temperature: type === "leader" || type === "leader_report" ? 0.35 : 0.25
    });
    return { content: content.trim(), _meta: { aiMode: "real" } };
  } catch (error) {
    return {
      content: generateSummary(record, type, preference),
      _meta: { aiMode: "mock", fallbackReason: error.message }
    };
  }
}

function polishVoiceText(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/(嗯|呃|额|啊|诶|那个|这个|就是|就是说|然后呢|然后|其实|反正|怎么说呢|我觉得吧|大概就是)/g, "")
    .replace(/([，。！？；、])\1+/g, "$1")
    .replace(/([，；、])([。！？])/g, "$2")
    .replace(/^[，。！？；、]+|[，；、]+$/g, "")
    .replace(/([。！？])([^。！？])/g, "$1$2")
    .trim();
}

async function polishVoiceTextWithMeta(text, preference = {}) {
  const cleaned = polishVoiceText(text);
  if (!cleaned) return { text: "", _meta: { aiMode: "mock", fallbackReason: "输入为空" } };
  if (!getAIConfig().apiKey) {
    return {
      text: cleaned,
      _meta: { aiMode: "mock", fallbackReason: "AI_API_KEY/DEEPSEEK_API_KEY 未配置" }
    };
  }

  try {
    const content = await callDeepSeek(buildPolishMessages(cleaned, preference), {
      maxTokens: 800,
      temperature: 0.1
    });
    return { text: content.trim(), _meta: { aiMode: "real" } };
  } catch (error) {
    return {
      text: cleaned,
      _meta: { aiMode: "mock", fallbackReason: error.message }
    };
  }
}

async function callDeepSeek(messages, options = {}) {
  const config = getAIConfig();
  if (!config.apiKey) throw new Error("AI_API_KEY/DEEPSEEK_API_KEY 未配置");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body = {
      model: config.model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens || 1200
    };
    if (options.responseFormat) body.response_format = options.responseFormat;

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`DeepSeek 返回非 JSON：${text.slice(0, 120)}`);
    }
    if (!response.ok) {
      const message = payload.error?.message || payload.message || `DeepSeek HTTP ${response.status}`;
      throw new Error(message);
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek 返回内容为空");
    return content;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("DeepSeek 请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildParseMessages(rawInput, preference = {}) {
  return [
    {
      role: "system",
      content: [
        "你是一个中文工作记录整理助手。",
        "请把用户的自然语言工作记录整理成严格 JSON。",
        "任务目标是准确转译用户原意：把口语表达转换成清晰、简洁、可执行的工作事项。",
        "只能输出 JSON 对象，不要 Markdown，不要解释。",
        "所有字段必须是字符串数组。",
        `字段固定为：${categories.join(", ")}。`,
        "字段缺少内容时返回空数组，不要省略字段。",
        "保留用户原始语义，不要翻译成英文，不要夸大、不要编造没有出现的事实。",
        "删除语气词、口头禅、重复词，但不要删除有效业务信息。",
        "问题、风险、卡点、阻塞、延期、不确定性必须优先放入 risks，绝对不要误放到 completedItems。",
        "明天、后续、接下来、继续、待处理、需要推进的事项优先放入 tomorrowTasks 或 ongoingItems，不要误判为已完成。",
        "完成、已提交、已沟通、已整理、已发布等确定完成的事项才放入 completedItems。",
        "感受、复盘、改进想法、优先级思考放入 reflections。",
        "如果文本提到已知项目、项目名、产品名、活动名，要放入 relatedProjects，并在 projectProgress 中保留项目进展。",
        "无法判断的内容放入 uncategorizedItems。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        rawInput,
        preference: {
          role: preference.role || "",
          workGoals: preference.workGoals || "",
          categoryPreferences: preference.categoryPreferences || "",
          keyProjects: preference.keyProjects || "",
          keywords: preference.keywords || "",
          collaborators: preference.collaborators || ""
        }
      })
    }
  ];
}

function buildSummaryMessages(record, type, preference = {}) {
  const label = {
    daily: "日报",
    tomorrow: "明日计划",
    tomorrow_plan: "明日计划",
    leader: "领导汇报版总结",
    leader_report: "领导汇报版总结",
    weekly: "周报",
    monthly: "月报",
    project: "项目复盘"
  }[type] || "周报";
  return [
    {
      role: "system",
      content: [
        "你是一个中文职场工作总结助手。",
        "根据结构化工作记录生成可直接使用的文本。",
        "表达要清晰、有条理，中文职场语气自然、简洁、正式。",
        "不要编造记录中不存在的事实，不要虚构数据、成果、时间或人员。",
        "如果某类内容为空，用“暂无明显...”或自然略过，不要硬凑内容。",
        "周报需要体现本周完成、进行中、下周计划、风险、复盘改进。",
        "月报需要体现核心成果、重点项目进展、未完成与下月计划、风险、经验复盘。",
        "项目复盘需要体现项目周期、完成成果、推进过程、问题风险、经验教训、后续事项。",
        "领导汇报版要更结果导向，突出推进、产出、风险和下一步。",
        "明日计划要可执行，尽量按重点推进、持续跟进、风险关注组织。",
        "不要使用 Markdown 标题、加粗、表格或代码块，使用普通中文分级标题和编号即可。",
        "只输出最终文本，不要解释生成过程。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        type: label,
        record,
        preference: {
          outputStyle: preference.outputStyle || "简洁正式",
          reportAudience: preference.reportAudience || "",
          dailyTemplate: preference.dailyTemplate || "",
          keyProjects: preference.keyProjects || "",
          keywords: preference.keywords || ""
        }
      })
    }
  ];
}

function buildPolishMessages(text, preference = {}) {
  return [
    {
      role: "system",
      content: [
        "你是一个中文语音转文字文本清理助手。",
        "请在不改变原意、不补充事实、不扩写内容的前提下，准确转译和清理语音识别文本。",
        "删除口头禅、重复词、无意义停顿词和多余标点。",
        "不要把用户没说过的内容翻译、推断或总结进去。",
        "保留原有工作事项、时间、人物、项目、待办和风险语义。",
        "输出一段可继续用于工作记录整理的中文文本。",
        "只输出润色后的文本，不要解释。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        text,
        preference: {
          role: preference.role || "",
          keywords: preference.keywords || "",
          keyProjects: preference.keyProjects || ""
        }
      })
    }
  ];
}

function normalizeAIRecord(parsed, rawInput, existingRecord = null, preference = {}) {
  const record = {
    id: existingRecord?.id || uid("record"),
    userId: "user_default",
    date: todayISO(),
    rawInput,
    createdAt: existingRecord?.createdAt || nowISO(),
    updatedAt: nowISO()
  };
  categories.forEach((key) => {
    record[key] = Array.isArray(parsed[key])
      ? parsed[key].map((item) => String(item).trim()).filter(Boolean)
      : [];
  });
  extractProjects(rawInput, preference).forEach((project) => addUnique(record.relatedProjects, project));
  record.relatedProjects = uniqueClean(record.relatedProjects);
  return record;
}

function parseJsonObject(content) {
  const trimmed = String(content || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI 未返回 JSON 对象");
    try {
      return JSON.parse(match[0]);
    } catch {
      throw new Error("AI JSON 解析失败");
    }
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function splitSentences(input) {
  return String(input || "")
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

function extractPeople(sentence, preference = {}) {
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
  splitPreferenceList(preference.collaborators).forEach((person) => {
    if (sentence.includes(person)) people.push(person);
  });
  return people.filter(Boolean);
}

function extractProjects(sentence, preference = {}) {
  const projects = [];
  const knownProjects = splitPreferenceList(preference.keyProjects);
  knownProjects.forEach((project) => {
    if (sentence.includes(project)) projects.push(project);
  });
  if (projects.length) return projects;
  [/([\u4e00-\u9fa5A-Za-z0-9]{2,12}项目)/g, /([\u4e00-\u9fa5A-Za-z0-9]{2,12}发布会)/g, /(播客选题)/g, /(宣传册)/g, /(官网改版)/g, /(数据看板)/g].forEach((pattern) => {
    let match = pattern.exec(sentence);
    while (match) {
      const cleaned = match[1].replace(/^(今天|明天|继续|跟进|推进|完成|整理|对齐)/, "").trim();
      if (cleaned.length >= 2) projects.push(cleaned);
      match = pattern.exec(sentence);
    }
  });
  return projects;
}

function splitPreferenceList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function asNumbered(items) {
  const list = items && items.length ? items : ["暂无"];
  return list.map((item, index) => `${index + 1}. ${item}`);
}

function uniqueClean(items) {
  return [...new Set((items || []).map((item) => item.trim()).filter(Boolean))];
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

module.exports = {
  categories,
  generateDailySummary,
  generateLeaderReport,
  generateMonthlySummary,
  generateProjectReview,
  generateSummary,
  generateSummaryWithMeta,
  generateTomorrowPlan,
  generateWeeklySummary,
  getAIStatus,
  parseWorkRecord,
  parseWorkRecordWithMeta,
  polishVoiceText,
  polishVoiceTextWithMeta,
  testAIConnection
};
