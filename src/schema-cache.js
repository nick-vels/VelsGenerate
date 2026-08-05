/**
 * Кэш схем моделей: docUrl → поля input (~/.velsgenerate/schema-cache.json, TTL 24ч).
 *
 * Нужен, чтобы `run` мог узнать поля незнакомой модели из живой документации,
 * не платя сетевым запросом за каждый запуск и не требуя обновления CLI при
 * появлении новых моделей в каталоге kie.ai.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchDoc } from "./registry.js";
import { deriveModelMeta, extractInputSchema } from "./schema.js";

export const SCHEMA_CACHE_PATH = path.join(os.homedir(), ".velsgenerate", "schema-cache.json");
export const SCHEMA_TTL_MS = 24 * 60 * 60 * 1000;

function readCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") return raw;
  } catch {
    // нет файла или битый JSON
  }
  return { entries: {} };
}

function writeCache(cache, cachePath) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch {
    // кэш — оптимизация: не можем записать (read-only FS) — работаем без него
  }
}

/**
 * Поля input модели по её docUrl: из кэша или из сети.
 * Возвращает { fields, meta, source: cache|live|stale-cache } либо null,
 * если схему получить не удалось (сеть недоступна и кэша нет).
 */
export async function loadModelSchema(docUrl, {
  refresh = false,
  cachePath = SCHEMA_CACHE_PATH,
  fetchImpl = fetchDoc,
  ttlMs = SCHEMA_TTL_MS,
} = {}) {
  if (!docUrl) return null;
  const cache = readCache(cachePath);
  const cached = cache.entries[docUrl];
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < ttlMs;

  if (cached && fresh && !refresh) {
    return { fields: cached.fields, meta: deriveModelMeta(cached.fields), source: "cache" };
  }

  try {
    const markdown = await fetchImpl(docUrl);
    const { fields } = extractInputSchema(markdown);
    if (fields.length > 0) {
      cache.entries[docUrl] = { fetchedAt: new Date().toISOString(), fields };
      writeCache(cache, cachePath);
      return { fields, meta: deriveModelMeta(fields), source: "live" };
    }
  } catch {
    // сеть недоступна или страница пропала — падаем на устаревший кэш ниже
  }

  if (cached) {
    return { fields: cached.fields, meta: deriveModelMeta(cached.fields), source: "stale-cache" };
  }
  return null;
}

/**
 * Метаданные модели с учётом её живой схемы.
 * Для моделей из seed-реестра выверенные вручную метаданные приоритетны, схема
 * лишь дополняет пропуски; для моделей живого каталога (dynamic) схема — источник истины.
 */
export function mergeModelMeta(model, schemaMeta) {
  if (!schemaMeta) return model;
  const merged = { ...model, schema_fields: schemaMeta.fields };

  if (model.dynamic || !model.api) {
    if (schemaMeta.prompt_field) merged.prompt_field = schemaMeta.prompt_field;
    if (schemaMeta.image_field) {
      merged.image_field = schemaMeta.image_field;
      merged.image_list = schemaMeta.image_list;
    }
    merged.required = schemaMeta.required;
    merged.defaults = { ...schemaMeta.defaults, ...(model.defaults || {}) };
    return merged;
  }

  // seed-модель: дополняем только то, чего в реестре нет
  if (!merged.image_field && schemaMeta.image_field) {
    merged.image_field = schemaMeta.image_field;
    merged.image_list = schemaMeta.image_list;
  }
  if ((merged.required || []).length === 0) merged.required = schemaMeta.required;
  merged.defaults = { ...schemaMeta.defaults, ...(model.defaults || {}) };
  return merged;
}
