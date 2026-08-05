/**
 * Динамический реестр моделей: живой каталог из https://docs.kie.ai/llms.txt
 * (раздел с market-страницами), кэш в ~/.velsvisual/models-cache.json (TTL 24ч),
 * мёрдж со seed-реестром (src/models.js).
 *
 * Цепочка fallback: свежий кэш → старый кэш → встроенный seed.
 * Seed имеет приоритет метаданных при совпадении id; динамика только добавляет
 * новые модели и подтверждает существование seed-моделей (иначе stale: true).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SEED_MODELS, dynamicModel } from "./models.js";

export const LLMS_TXT_URL = "https://docs.kie.ai/llms.txt";
export const CACHE_PATH = path.join(os.homedir(), ".velsvisual", "models-cache.json");
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CONCURRENCY = 8;

const CATEGORY_BY_BREADCRUMB = {
  "image models": "image",
  "video models": "video",
  "music models": "audio",
  // "chat models" — пропускаем
};

// - Image    Models > Google [Google - Nano Banana](https://docs.kie.ai/market/google/nano-banana.md): описание
const LLMS_LINE_RE =
  /^-\s+([A-Za-z][A-Za-z ]*?Models)\b[^[]*\[([^\]]+)\]\((https:\/\/docs\.kie\.ai\/market\/[^)\s]+?\.md)\)\s*:?\s*(.*)$/;

// id модели в JSON-примерах и YAML OpenAPI-спеках market-страниц
const MODEL_JSON_RE = /"model"\s*:\s*"([^"]+)"/g;
const MODEL_YAML_RE = /^\s*model:\s*([A-Za-z0-9][\w./-]*)\s*$/gm;

function isPlausibleModelId(value) {
  return (
    value.length >= 4 &&
    /[a-zA-Z]/.test(value) &&
    /^[\w./-]+$/.test(value) &&
    !value.startsWith("http") &&
    !value.includes("/api/")
  );
}

/**
 * Парсинг llms.txt → список market-страниц:
 * [{ url, category, title, description }]. /cn/-ссылки и Chat Models пропускаются.
 */
export function parseLlmsTxt(text) {
  const pages = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    const match = LLMS_LINE_RE.exec(line.trim());
    if (!match) continue;
    const [, breadcrumb, title, url, description] = match;
    if (url.includes("/cn/")) continue;
    const category = CATEGORY_BY_BREADCRUMB[breadcrumb.replace(/\s+/g, " ").toLowerCase()];
    if (!category || seen.has(url)) continue;
    seen.add(url);
    // В llms.txt описание иногда содержит обрывок markdown ("## Query Task Status") —
    // в таком случае берём заголовок страницы.
    const desc = description.trim();
    pages.push({ url, category, title, description: desc.startsWith("#") ? "" : desc });
  }
  return pages;
}

/**
 * Извлечение model id из .md-страницы документации.
 * Возвращает массив id по убыванию частоты (первый — основной).
 */
export function extractModelIds(markdown) {
  const counts = new Map();
  const order = [];
  const add = (value) => {
    if (!isPlausibleModelId(value)) return;
    if (!counts.has(value)) {
      counts.set(value, 0);
      order.push(value);
    }
    counts.set(value, counts.get(value) + 1);
  };
  for (const match of markdown.matchAll(MODEL_JSON_RE)) add(match[1]);
  for (const match of markdown.matchAll(MODEL_YAML_RE)) add(match[1]);
  return order.sort((a, b) => counts.get(b) - counts.get(a));
}

/**
 * Мёрдж живого каталога с seed-реестром.
 * liveEntries: [{ id, category, description, docUrl }] → записи dynamicModel.
 * Возвращает Map<id, entry>. Seed вне живого каталога → stale: true.
 */
export function mergeRegistries(liveEntries, seed = SEED_MODELS) {
  const merged = new Map();
  for (const entry of liveEntries) {
    merged.set(entry.id, {
      ...dynamicModel(entry.category, entry.description),
      docUrl: entry.docUrl,
    });
  }
  for (const [id, seedEntry] of Object.entries(seed)) {
    if (merged.has(id)) {
      // seed приоритетен по метаданным; подтверждено живым каталогом — не stale
      merged.set(id, {
        ...seedEntry,
        stale: false,
        docUrl: merged.get(id).docUrl || seedEntry.docUrl || null,
      });
    } else {
      // Выделенные API (veo/suno/flux/gpt4o/runway) в market-каталог не входят
      // и живыми страницами не подтверждаются — они не stale.
      merged.set(id, { ...seedEntry, stale: !seedEntry.dedicated });
    }
  }
  return merged;
}

async function fetchText(url, timeoutMs = 30_000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} для ${url}`);
  return resp.text();
}

/** Скачивает markdown-страницу документации модели (docs.kie.ai/market/...). */
export function fetchDoc(url, timeoutMs = 30_000) {
  return fetchText(url, timeoutMs);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Скачивает живой каталог: llms.txt + все market-страницы (concurrency 8).
 * Возвращает [{ id, category, description, docUrl }].
 */
export async function fetchLiveCatalog(fetchImpl = fetchText) {
  const llmsTxt = await fetchImpl(LLMS_TXT_URL);
  const pages = parseLlmsTxt(llmsTxt);
  const perPage = await mapWithConcurrency(pages, CONCURRENCY, async (page) => {
    try {
      const markdown = await fetchImpl(page.url);
      const ids = extractModelIds(markdown);
      if (ids.length === 0) return null;
      return {
        id: ids[0],
        category: page.category,
        description: page.description || page.title,
        docUrl: page.url,
      };
    } catch {
      return null; // страница недоступна — пропускаем, не роняем весь каталог
    }
  });
  const seen = new Set();
  const entries = [];
  for (const entry of perPage) {
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

function readCache(cachePath = CACHE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (raw && Array.isArray(raw.models) && raw.fetchedAt) return raw;
  } catch {
    // нет файла или битый JSON — считаем, что кэша нет
  }
  return null;
}

function writeCache(models, cachePath = CACHE_PATH) {
  const cache = { fetchedAt: new Date().toISOString(), models };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cache;
}

function seedOnlyRegistry(source = "seed") {
  const models = new Map();
  for (const [id, entry] of Object.entries(SEED_MODELS)) {
    models.set(id, { ...entry });
  }
  return { models, source, fetchedAt: null };
}

/**
 * Загрузка реестра.
 * - refresh: принудительно обновить из сети.
 * - allowFetch: разрешить авто-обновление при протухшем кэше (для `models`;
 *   для `run` вызываем с false, чтобы не тянуть сеть на каждый запуск).
 * Результат: { models: Map<id, entry>, source: live|cache|seed, fetchedAt }.
 */
export async function loadRegistry({
  refresh = false,
  allowFetch = true,
  cachePath = CACHE_PATH,
  fetchImpl = fetchText,
  onWarning = null,
} = {}) {
  const cache = readCache(cachePath);
  const cacheFresh = cache && Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL_MS;

  const shouldFetch = allowFetch && (refresh || !cacheFresh);
  if (shouldFetch) {
    try {
      const live = await fetchLiveCatalog(fetchImpl);
      if (live.length > 0) {
        const written = writeCache(live, cachePath);
        return {
          models: mergeRegistries(live),
          source: "live",
          fetchedAt: written.fetchedAt,
        };
      }
      throw new Error("живой каталог пуст");
    } catch (exc) {
      if (onWarning) onWarning(`Не удалось обновить каталог моделей (${exc.message}).`);
    }
  }

  if (cache) {
    return {
      models: mergeRegistries(cache.models),
      source: "cache",
      fetchedAt: cache.fetchedAt,
    };
  }
  return seedOnlyRegistry();
}
