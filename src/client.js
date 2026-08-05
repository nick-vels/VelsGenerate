/**
 * HTTP-клиент KIE API (https://docs.kie.ai). Ноль зависимостей: fetch/FormData/Blob из Node >= 18.
 *
 * Конверт ответа: {"code": 200, "msg": "success", "data": ...}; успех — code == 200.
 * Коды ошибок: 401 ключ, 402 кредиты, 422 валидация, 429 rate limit,
 * 451 не скачалось входное изображение, 455 maintenance, 501 генерация не удалась.
 */

import fs from "node:fs";
import path from "node:path";

export const BASE_URL = "https://api.kie.ai";
export const UPLOAD_URL = "https://kieai.redpandaai.co/api/file-stream-upload";

export const CREATE_ENDPOINTS = {
  jobs: "/api/v1/jobs/createTask",
  veo: "/api/v1/veo/generate",
  runway: "/api/v1/runway/generate",
  gpt4o: "/api/v1/gpt4o-image/generate",
  flux: "/api/v1/flux/kontext/generate",
  suno: "/api/v1/generate",
};

export const STATUS_ENDPOINTS = {
  jobs: "/api/v1/jobs/recordInfo",
  veo: "/api/v1/veo/record-info",
  runway: "/api/v1/runway/record-detail",
  gpt4o: "/api/v1/gpt4o-image/record-info",
  flux: "/api/v1/flux/kontext/record-info",
  suno: "/api/v1/generate/record-info",
};

// Порядок перебора API при автоопределении по taskId (status/wait без --api).
export const CASCADE_ORDER = ["jobs", "veo", "suno", "gpt4o", "flux", "runway"];

const NOT_FOUND_MARKERS = ["not found", "not exist", "no such", "does not exist", "не найден"];

const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);

/** Ошибка API или сети. code — код из конверта ответа (может быть null). */
export class KieError extends Error {
  constructor(msg, code = null) {
    super(code !== null ? `Ошибка KIE API (code=${code}): ${msg}` : `Ошибка: ${msg}`);
    this.name = "KieError";
    this.code = code;
    this.msg = String(msg);
  }
}

/** Задача с таким taskId не найдена в данном API (code==404 или msg «not found»). */
export class TaskNotFound extends KieError {
  constructor(msg, code = null) {
    super(msg, code);
    this.name = "TaskNotFound";
  }
}

function guessUploadPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "videos";
  return "images";
}

/**
 * Достаёт URL загруженного файла из ответа upload-эндпоинта.
 * Схема ответа менялась: downloadUrl (актуальная), fileUrl/url (старые),
 * плюс данные иногда лежат во вложенном объекте (data/result/file).
 * Возвращает URL или null.
 */
export function extractFileUrl(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 3) return null;
  for (const key of ["downloadUrl", "fileUrl", "url", "fileURL", "download_url", "file_url"]) {
    const value = data[key];
    if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  }
  for (const key of ["data", "result", "file", "fileInfo"]) {
    const nested = extractFileUrl(data[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Приводит ответ status-эндпоинта к единому виду:
 * { api, state: pending|success|fail, urls, tracks, fail_msg, progress, raw }.
 */
export function normalizeStatus(api, data) {
  const result = {
    api,
    state: "pending",
    urls: [],
    tracks: [],
    fail_msg: null,
    progress: null,
    raw: data,
  };
  data = data || {};

  if (api === "jobs" || (api === "gpt4o" && data.successFlag === undefined && "state" in data)) {
    const state = data.state;
    result.progress = data.progress ?? null;
    if (state === "success") {
      result.state = "success";
      if (data.resultJson) {
        try {
          result.urls = JSON.parse(data.resultJson).resultUrls || [];
        } catch {
          result.urls = [];
        }
      }
    } else if (state === "fail") {
      result.state = "fail";
      const failMsg = data.failMsg || "генерация не удалась";
      result.fail_msg = data.failCode ? `[${data.failCode}] ${failMsg}` : failMsg;
    }
    return result;
  }

  if (api === "veo" || api === "gpt4o" || api === "flux") {
    const flag = data.successFlag;
    if (flag === 1) {
      result.state = "success";
      if (api === "flux") {
        result.urls = data.resultImageUrl ? [data.resultImageUrl] : [];
      } else {
        result.urls = (data.response && data.response.resultUrls) || [];
      }
    } else if (flag === 2 || flag === 3) {
      result.state = "fail";
      result.fail_msg = data.errorMessage || data.failMsg || "генерация не удалась";
    }
    return result;
  }

  if (api === "runway") {
    const state = data.state;
    if (state === "success") {
      result.state = "success";
      let url = data.videoInfo && data.videoInfo.videoUrl;
      if (!url) url = ((data.response && data.response.resultUrls) || [null])[0];
      result.urls = url ? [url] : [];
    } else if (state === "fail") {
      result.state = "fail";
      result.fail_msg = data.failMsg || "генерация не удалась";
    }
    return result;
  }

  if (api === "suno") {
    const status = String(data.status || "");
    if (status === "SUCCESS") {
      result.state = "success";
      const tracks = (data.response && data.response.sunoData) || [];
      result.tracks = tracks.map((t) => ({
        audioUrl: t.audioUrl ?? null,
        streamAudioUrl: t.streamAudioUrl ?? null,
        imageUrl: t.imageUrl ?? null,
        duration: t.duration ?? null,
        title: t.title ?? null,
      }));
      result.urls = result.tracks.filter((t) => t.audioUrl).map((t) => t.audioUrl);
    } else if (status.includes("FAILED") || status === "SENSITIVE_WORD_ERROR") {
      result.state = "fail";
      result.fail_msg = data.errorMessage || status || "генерация не удалась";
    }
    // PENDING | TEXT_SUCCESS | FIRST_SUCCESS — ещё в работе
    return result;
  }

  return result;
}

/** Тонкий клиент KIE API: Bearer-авторизация, конверт code/msg/data. */
export class KieClient {
  constructor(apiKey, baseUrl = BASE_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  static async _handle(resp) {
    let payload;
    try {
      payload = await resp.json();
    } catch {
      const text = await resp.text().catch(() => "");
      throw new KieError(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new KieError(`Неожиданный ответ API: ${String(payload).slice(0, 300)}`);
    }
    const code = payload.code;
    if (code === 200) return payload.data;
    // upload-хост иногда отвечает без конверта: {success: true, downloadUrl: ...}
    if (code === undefined && payload.success === true && resp.ok) return payload;
    const msg = String(payload.msg || payload.message || "");
    if (code === 404 || NOT_FOUND_MARKERS.some((m) => msg.toLowerCase().includes(m))) {
      throw new TaskNotFound(msg || "задача не найдена", code);
    }
    throw new KieError(msg || `HTTP ${resp.status}`, code);
  }

  async _post(urlPath, body) {
    let resp;
    try {
      resp = await fetch(this.baseUrl + urlPath, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (exc) {
      throw new KieError(`сетевая ошибка: ${exc.message}`);
    }
    return KieClient._handle(resp);
  }

  async _get(urlPath, params = {}) {
    const qs = new URLSearchParams(params).toString();
    let resp;
    try {
      resp = await fetch(this.baseUrl + urlPath + (qs ? `?${qs}` : ""), {
        headers: this._headers(),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (exc) {
      throw new KieError(`сетевая ошибка: ${exc.message}`);
    }
    return KieClient._handle(resp);
  }

  /** Баланс кредитов (GET /api/v1/chat/credit). */
  credits() {
    return this._get("/api/v1/chat/credit");
  }

  /** Загрузка файла (multipart, хост kieai.redpandaai.co) → fileUrl. */
  async upload(filePath, uploadPath = null) {
    if (!uploadPath) uploadPath = guessUploadPath(filePath);
    const name = path.basename(filePath);
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(filePath)]), name);
    form.append("uploadPath", uploadPath);
    form.append("fileName", name);
    let resp;
    try {
      resp = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(300_000),
      });
    } catch (exc) {
      throw new KieError(`сетевая ошибка при загрузке: ${exc.message}`);
    }
    const data = await KieClient._handle(resp);
    const url = extractFileUrl(data);
    if (url) return url;
    throw new KieError(`загрузка файла: неожиданный ответ: ${JSON.stringify(data)}`);
  }

  /** Создание задачи генерации. Возвращает taskId. */
  async create(api, modelId, inputData, callbackUrl = null) {
    if (!(api in CREATE_ENDPOINTS)) throw new KieError(`неизвестный тип API: ${api}`);
    let body;
    if (api === "jobs") {
      body = { model: modelId, input: { ...inputData } };
    } else if (api === "veo" || api === "flux") {
      body = { ...inputData, model: modelId };
    } else {
      // runway, gpt4o, suno — плоское тело
      body = { ...inputData };
    }
    if (callbackUrl) body.callBackUrl = callbackUrl;
    const data = await this._post(CREATE_ENDPOINTS[api], body);
    if (data && typeof data === "object") {
      const taskId = data.taskId || data.task_id || data.id;
      if (taskId) return String(taskId);
    }
    throw new KieError(`создание задачи: неожиданный ответ: ${JSON.stringify(data)}`);
  }

  /** Нормализованный статус задачи (см. normalizeStatus). */
  async status(api, taskId) {
    if (!(api in STATUS_ENDPOINTS)) throw new KieError(`неизвестный тип API: ${api}`);
    const data = await this._get(STATUS_ENDPOINTS[api], { taskId });
    return normalizeStatus(api, data && typeof data === "object" ? data : {});
  }
}

/** Скачивает файл по URL в локальный путь dest. */
export async function downloadFile(url, dest) {
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  } catch (exc) {
    throw new KieError(`скачивание ${url}: ${exc.message}`);
  }
  if (!resp.ok) throw new KieError(`скачивание ${url}: HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return dest;
}
