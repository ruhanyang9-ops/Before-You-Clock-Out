const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_STT_MODEL = "whisper-1";
const DEFAULT_TIMEOUT_MS = 30000;
const BAIDU_TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_ASR_URL = "https://vop.baidu.com/server_api";

let baiduTokenCache = null;

function getSpeechConfig() {
  const baiduApiKey = process.env.BAIDU_API_KEY || process.env.BAIDU_SPEECH_API_KEY || "";
  const baiduSecretKey = process.env.BAIDU_SECRET_KEY || process.env.BAIDU_SPEECH_SECRET_KEY || "";
  if (baiduApiKey && baiduSecretKey) {
    return {
      provider: "baidu",
      apiKey: baiduApiKey,
      secretKey: baiduSecretKey,
      baseUrl: BAIDU_ASR_URL,
      model: process.env.BAIDU_DEV_PID || "1537",
      cuid: process.env.BAIDU_CUID || "afterwork-five-minutes",
      timeoutMs: Number(process.env.STT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
    };
  }

  const apiKey = process.env.STT_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = (process.env.STT_BASE_URL || DEFAULT_STT_BASE_URL).replace(/\/+$/, "");
  const model = process.env.STT_MODEL || DEFAULT_STT_MODEL;
  const timeoutMs = Number(process.env.STT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    provider: "openai-compatible",
    apiKey,
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

function getSpeechStatus() {
  const config = getSpeechConfig();
  return {
    enabled: Boolean(config.apiKey),
    provider: config.provider,
    model: config.model,
    baseUrlHost: safeHost(config.baseUrl),
    mode: config.apiKey ? "backend" : "browser-only"
  };
}

async function transcribeAudio(buffer, contentType = "audio/webm") {
  const config = getSpeechConfig();
  if (!config.apiKey) throw new Error("BAIDU_API_KEY/BAIDU_SECRET_KEY 或 STT_API_KEY 未配置");
  if (!buffer?.length) throw new Error("音频内容为空");
  if (config.provider === "baidu") return transcribeBaiduAudio(buffer, contentType, config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const form = new FormData();
    const extension = extensionFromContentType(contentType);
    form.append("model", config.model);
    form.append("file", new Blob([buffer], { type: contentType }), `voice-record.${extension}`);

    const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      },
      body: form,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`语音转写服务返回非 JSON：${text.slice(0, 120)}`);
    }
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.message || `语音转写 HTTP ${response.status}`);
    }
    const transcript = payload.text || payload.transcript || payload.result;
    if (!transcript) throw new Error("语音转写结果为空");
    return {
      text: String(transcript).trim(),
      _meta: {
        speechMode: "backend",
        provider: getSpeechStatus().provider,
        model: config.model
      }
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("语音转写请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeBaiduAudio(buffer, contentType, config) {
  const token = await getBaiduAccessToken(config);
  const format = baiduFormatFromContentType(contentType);
  const body = {
    format,
    rate: 16000,
    channel: 1,
    cuid: config.cuid,
    token,
    dev_pid: Number(config.model) || 1537,
    speech: buffer.toString("base64"),
    len: buffer.length
  };
  const response = await fetch(BAIDU_ASR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new Error(`百度语音识别 HTTP ${response.status}`);
  }
  if (payload.err_no !== 0) {
    throw new Error(payload.err_msg || `百度语音识别失败：${payload.err_no}`);
  }
  const text = Array.isArray(payload.result) ? payload.result.join("") : "";
  if (!text.trim()) throw new Error("百度语音识别结果为空");
  return {
    text: text.trim(),
    _meta: {
      speechMode: "backend",
      provider: "baidu",
      model: String(config.model)
    }
  };
}

async function getBaiduAccessToken(config) {
  if (baiduTokenCache && baiduTokenCache.expiresAt > Date.now() + 60_000) {
    return baiduTokenCache.token;
  }
  const url = new URL(BAIDU_TOKEN_URL);
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", config.apiKey);
  url.searchParams.set("client_secret", config.secretKey);
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || "百度 access_token 获取失败");
  }
  baiduTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 2_592_000) * 1000
  };
  return baiduTokenCache.token;
}

function baiduFormatFromContentType(contentType) {
  if (/pcm/.test(contentType)) return "pcm";
  if (/m4a|mp4/.test(contentType)) return "m4a";
  if (/amr/.test(contentType)) return "amr";
  return "wav";
}

function extensionFromContentType(contentType) {
  if (/mp4|m4a/.test(contentType)) return "m4a";
  if (/mpeg|mp3/.test(contentType)) return "mp3";
  if (/wav/.test(contentType)) return "wav";
  if (/ogg/.test(contentType)) return "ogg";
  return "webm";
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

module.exports = {
  getSpeechStatus,
  transcribeAudio
};
