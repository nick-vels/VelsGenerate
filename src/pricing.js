/**
 * Прайс-лист KIE: публичный эндпоинт https://api.kie.ai/client/v1/model-pricing/page
 * (его использует страница kie.ai/pricing), кэш в ~/.velsvisual/pricing-cache.json
 * (TTL 24ч). Цены зависят от параметров (разрешение, режим) — у одной модели
 * может быть несколько записей.
 *
 * Цепочка fallback: свежий кэш → сеть → старый кэш → пустой список (source: "none").
 * Chat-модели (LLM) пропускаем — CLI генерирует только image/video/audio.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRICING_URL = "https://api.kie.ai/client/v1/model-pricing/page";
export const CACHE_PATH = path.join(os.homedir(), ".velsvisual", "pricing-cache.json");
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const PAGE_SIZE = 100;

/** Курс пересчёта на случай отсутствия usdPrice в записи: 1 кредит = $0.005. */
export const USD_PER_CREDIT = 0.005;

const CATEGORY_BY_INTERFACE = {
  image: "image",
  video: "video",
  music: "audio",
  // "chat" — пропускаем
};

/** id модели из ссылки записи прайса: anchor "...?model=qwen3%2Fpro-image-to-image". */
export function extractModelId(anchor) {
  if (!anchor) return null;
  const match = /[?&]model=([^&]+)/.exec(anchor);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Нормализация сырой записи API →
 * { id|null, category, description, credits, usd, unit, provider }.
 * Возвращает null для записей вне image/video/audio.
 */
export function normalizeRecord(raw) {
  const category = CATEGORY_BY_INTERFACE[String(raw.interfaceType || "").toLowerCase()];
  if (!category) return null;
  const credits = Number(raw.creditPrice);
  if (!Number.isFinite(credits)) return null;
  const usdRaw = Number(raw.usdPrice);
  const usd = raw.usdPrice !== undefined && raw.usdPrice !== null && raw.usdPrice !== "" && Number.isFinite(usdRaw)
    ? usdRaw
    : credits * USD_PER_CREDIT;
  return {
    id: extractModelId(raw.anchor),
    category,
    description: String(raw.modelDescription || ""),
    credits,
    usd,
    unit: String(raw.creditUnit || ""),
    provider: String(raw.provider || ""),
  };
}

async function fetchPage(pageNum, pageSize, timeoutMs = 30_000) {
  const resp = await fetch(PRICING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageNum, pageSize, modelDescription: "", interfaceType: "" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} для ${PRICING_URL}`);
  const body = await resp.json();
  if (body.code !== 200 || !body.data) {
    throw new Error(`прайс-лист KIE вернул ошибку: ${body.msg || `code ${body.code}`}`);
  }
  return body.data;
}

/**
 * Скачивает весь прайс-лист (постранично).
 * Возвращает нормализованные записи (без chat).
 */
export async function fetchPricing(fetchImpl = fetchPage) {
  const records = [];
  let pageNum = 1;
  for (;;) {
    const data = await fetchImpl(pageNum, PAGE_SIZE);
    const batch = Array.isArray(data.records) ? data.records : [];
    for (const raw of batch) {
      const record = normalizeRecord(raw);
      if (record) records.push(record);
    }
    const total = Number(data.total) || 0;
    if (batch.length === 0 || records.length >= total) break;
    pageNum += 1;
  }
  return records;
}

function readCache(cachePath = CACHE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (raw && Array.isArray(raw.records) && raw.fetchedAt) return raw;
  } catch {
    // нет файла или битый JSON — считаем, что кэша нет
  }
  return null;
}

function writeCache(records, cachePath = CACHE_PATH) {
  const cache = { fetchedAt: new Date().toISOString(), records };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cache;
}

/**
 * Загрузка прайс-листа. Контракт как у loadRegistry:
 * { records, source: live|cache|none, fetchedAt }.
 */
export async function loadPricing({
  refresh = false,
  allowFetch = true,
  cachePath = CACHE_PATH,
  fetchImpl = fetchPage,
  onWarning = null,
} = {}) {
  const cache = readCache(cachePath);
  const cacheFresh = cache && Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL_MS;
  if (cacheFresh && !refresh) {
    return { records: cache.records, source: "cache", fetchedAt: cache.fetchedAt };
  }

  if (allowFetch) {
    try {
      const records = await fetchPricing(fetchImpl);
      if (records.length > 0) {
        const written = writeCache(records, cachePath);
        return { records, source: "live", fetchedAt: written.fetchedAt };
      }
      throw new Error("прайс-лист пуст");
    } catch (exc) {
      if (onWarning) onWarning(`Не удалось обновить прайс-лист (${exc.message}).`);
    }
  }

  if (cache) {
    return { records: cache.records, source: "cache", fetchedAt: cache.fetchedAt };
  }
  return { records: [], source: "none", fetchedAt: null };
}

/** Токены строки для нечёткого сравнения: lowercase, разбиение по не-буквам/цифрам
 *  и по границам буква↔цифра ("imagen4" → "imagen", "4"; "veo3" → "veo", "3"). */
export function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Сводка цен по конкретному id модели:
 * { creditsMin, creditsMax, usdMin, usdMax, units, approximate } или null.
 * Сначала точное совпадение id (anchor "?model=..."); если записей нет —
 * нечёткое: все токены id модели содержатся в описании записи прайса
 * ("veo3" → "Google veo 3.1, text-to-video, …"). Нечёткое совпадение
 * помечается approximate: true — это оценка, а не точный тариф.
 */
export function priceForModel(records, modelId) {
  const summarize = (matched, approximate) => {
    const credits = matched.map((r) => r.credits);
    const usd = matched.map((r) => r.usd);
    return {
      creditsMin: Math.min(...credits),
      creditsMax: Math.max(...credits),
      usdMin: Math.min(...usd),
      usdMax: Math.max(...usd),
      units: [...new Set(matched.map((r) => r.unit.trim()).filter(Boolean))],
      approximate,
    };
  };
  const exact = records.filter((r) => r.id === modelId);
  if (exact.length > 0) return summarize(exact, false);
  const modelTokens = tokenize(modelId);
  if (modelTokens.length === 0) return null;
  const fuzzy = records.filter((r) => {
    const haystack = new Set(tokenize(r.description));
    return modelTokens.every((token) => haystack.has(token));
  });
  return fuzzy.length > 0 ? summarize(fuzzy, true) : null;
}
