/**
 * VelsGenerate — CLI для генерации фото/видео/аудио через KIE API (kie.ai).
 * Парсер аргументов — hand-rolled, ноль зависимостей.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CASCADE_ORDER,
  KieClient,
  KieError,
  TaskNotFound,
  downloadFile,
} from "./client.js";
import { APIS, CATEGORIES } from "./models.js";
import { loadPricing } from "./pricing.js";
import { recommend } from "./recommend.js";
import { fetchDoc, loadRegistry } from "./registry.js";
import { extractInputSchema, formatField } from "./schema.js";
import { loadModelSchema, mergeModelMeta } from "./schema-cache.js";
import { runSetup } from "./setup.js";

export const VERSION = "0.1.0";
export const CONFIG_PATH = path.join(os.homedir(), ".velsgenerate", "config.json");

/** Ошибка использования CLI (exit code 2). */
export class UsageError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "UsageError";
  }
}

// Заготовка для моделей вне реестра (при явном --api).
const GENERIC_MODEL = {
  category: "unknown",
  api: null,
  prompt_field: "prompt",
  image_field: "image_url",
  image_list: false,
  required: [],
  description: "Модель вне реестра.",
};

// ------------------------------------------------------------------ args
/**
 * Мини-парсер аргументов.
 * spec: { bool: [...], value: [...], multi: [...], alias: { "-o": "--output" } }
 * Возвращает { flags, positionals }.
 */
export function parseArgs(argv, spec = {}) {
  const bools = new Set(spec.bool || []);
  const values = new Set(spec.value || []);
  const multis = new Set(spec.multi || []);
  const alias = spec.alias || {};
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    let arg = alias[argv[i]] || argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      let inlineValue = null;
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        inlineValue = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
      if (bools.has(arg)) {
        if (inlineValue !== null) throw new UsageError(`Флаг ${arg} не принимает значение.`);
        flags[arg] = true;
      } else if (values.has(arg) || multis.has(arg)) {
        let value = inlineValue;
        if (value === null) {
          value = argv[++i];
          if (value === undefined) throw new UsageError(`Флаг ${arg} требует значение.`);
        }
        if (multis.has(arg)) {
          (flags[arg] = flags[arg] || []).push(value);
        } else {
          flags[arg] = value;
        }
      } else {
        throw new UsageError(`Неизвестный флаг: ${arg}`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

// ------------------------------------------------------------------ helpers
/** Значение --set: пробуем JSON (true/false/числа/массивы), иначе строка. */
export function parseSetValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseSetPairs(pairs) {
  const result = {};
  for (const pair of pairs || []) {
    const eq = pair.indexOf("=");
    if (eq === -1) throw new UsageError(`--set ожидает формат ключ=значение, получено: ${JSON.stringify(pair)}`);
    const key = pair.slice(0, eq).trim();
    if (!key) throw new UsageError(`--set: пустой ключ в ${JSON.stringify(pair)}`);
    result[key] = parseSetValue(pair.slice(eq + 1));
  }
  return result;
}

/** Запись реестра по id модели; для моделей вне реестра нужен --api. */
export function resolveModel(modelId, apiOverride = null, registryModels = null) {
  const entry = registryModels ? registryModels.get(modelId) : null;
  if (entry) return { ...entry, id: modelId };
  if (apiOverride) return { ...GENERIC_MODEL, api: apiOverride, id: modelId };
  throw new UsageError(
    `Неизвестная модель: ${JSON.stringify(modelId)}.\n` +
      "Список моделей: velsgenerate models\n" +
      "Для модели вне реестра укажите тип API: --api jobs|veo|runway|gpt4o|flux|suno"
  );
}

/**
 * Собирает input модели: --prompt/--image, затем --set, затем --json-input поверх.
 * Чистая функция без сети: локальные пути в images подставляются как есть
 * (загрузка происходит позже, в resolveImages).
 */
export function buildInput(model, { prompt = null, images = null, setPairs = null, jsonInputStr = null } = {}) {
  const data = {};
  if (prompt !== null && prompt !== undefined) {
    const promptField = model.prompt_field;
    if (promptField) {
      data[promptField] = prompt;
    } else {
      console.error("Предупреждение: модель не принимает промпт, --prompt проигнорирован.");
    }
  }
  if (images && images.length > 0) {
    const imageField = model.image_field;
    if (!imageField) {
      // У моделей из живого каталога поле картинки не описано в реестре: имя поля
      // (image_url / image_urls / first_frame_url / …) смотрим в схеме модели.
      throw new UsageError(
        `Для модели ${model.id || ""} не известно поле изображения, флаг --image не подходит.\n` +
          `Посмотрите схему:  velsgenerate schema ${model.id || "МОДЕЛЬ"}\n` +
          "и передайте файл или URL в нужное поле: --set ПОЛЕ=ПУТЬ_ИЛИ_URL\n" +
          "(локальный файл в любом поле CLI загрузит автоматически)"
      );
    }
    if (model.image_list) {
      data[imageField] = [...images];
    } else {
      if (images.length > 1) {
        throw new UsageError(`Поле ${imageField} принимает одно изображение, передано: ${images.length}.`);
      }
      data[imageField] = images[0];
    }
  }
  // Обязательные поля, у которых в схеме есть значение по умолчанию:
  // без них API отвечает 422, а угадывать их пользователю незачем.
  for (const [field, value] of Object.entries(model.defaults || {})) {
    if (data[field] === undefined) data[field] = value;
  }
  Object.assign(data, parseSetPairs(setPairs));
  if (jsonInputStr) {
    let extra;
    try {
      extra = JSON.parse(jsonInputStr);
    } catch (exc) {
      throw new UsageError(`--json-input: невалидный JSON: ${exc.message}`);
    }
    if (extra === null || typeof extra !== "object" || Array.isArray(extra)) {
      throw new UsageError("--json-input должен быть JSON-объектом.");
    }
    Object.assign(data, extra);
  }
  if (model.api === "suno" && data.model === undefined) data.model = "V5";
  return data;
}

/** Проверка обязательных полей ДО запроса к API. */
export function validateInput(model, data) {
  const missing = [];
  for (const field of model.required || []) {
    const value = data[field];
    if (value === undefined || value === null || value === "" ||
        (Array.isArray(value) && value.length === 0)) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    const lines = missing.map((field) => {
      let hint;
      if (field === model.image_field) hint = "--image ФАЙЛ_ИЛИ_URL";
      else if (field === model.prompt_field) hint = "--prompt ТЕКСТ";
      else hint = `--set ${field}=ЗНАЧЕНИЕ`;
      return `  - ${field} (задайте через ${hint})`;
    });
    const tail = model.id
      ? `\nВсе поля модели: velsgenerate schema ${model.id}`
      : "";
    throw new UsageError("Не заполнены обязательные поля модели:\n" + lines.join("\n") + tail);
  }
  if (model.api === "gpt4o" && !data.prompt && !data.filesUrl) {
    throw new UsageError("gpt4o-image требует --prompt и/или --image (filesUrl).");
  }
  if (model.api === "suno" && data.customMode) {
    for (const field of ["style", "title"]) {
      if (!data[field]) {
        throw new UsageError(`Suno в customMode требует поле '${field}' (--set ${field}=...).`);
      }
    }
  }
}

function isRemoteRef(value) {
  return typeof value === "string" && /^(https?:\/\/|asset:\/\/|data:)/.test(value);
}

function isLocalFile(value) {
  if (typeof value !== "string" || value === "" || isRemoteRef(value)) return false;
  try {
    return fs.existsSync(value) && fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

/**
 * Заменяет локальные пути на URL после upload — во ВСЕХ полях input, не только
 * в image_field: у моделей живого каталога файл передаётся через --set
 * (first_frame_url, image_url, reference_image_urls, ...). Промпт не трогаем.
 * Поле image_field строгое: там путь обязан быть файлом или URL.
 */
export async function resolveLocalFiles(client, model, data, log = console.error) {
  const uploaded = new Map();
  const upload = async (filePath) => {
    const key = path.resolve(filePath);
    if (!uploaded.has(key)) {
      log(`Загрузка файла ${filePath} ...`);
      const url = await client.upload(filePath);
      log(`  -> ${url}`);
      uploaded.set(key, url);
    }
    return uploaded.get(key);
  };

  for (const [field, value] of Object.entries(data)) {
    if (field === model.prompt_field) continue;
    const strict = field === model.image_field;
    const resolve = async (item) => {
      if (isLocalFile(item)) return upload(item);
      if (strict && typeof item === "string" && !isRemoteRef(item)) {
        throw new UsageError(`--image: не файл и не URL: ${item}`);
      }
      return item;
    };
    if (Array.isArray(value)) {
      const resolved = [];
      for (const item of value) resolved.push(await resolve(item));
      data[field] = resolved;
    } else {
      data[field] = await resolve(value);
    }
  }
}

/** KIE_API_KEY из env, иначе ~/.velsgenerate/config.json. */
export function getApiKey() {
  const envKey = (process.env.KIE_API_KEY || "").trim();
  if (envKey) return envKey;
  try {
    const key = String(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).api_key || "").trim();
    if (key) return key;
  } catch {
    // нет файла или битый JSON
  }
  return null;
}

export function saveApiKey(key) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ api_key: key }, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function makeClient() {
  const key = getApiKey();
  if (!key) {
    throw new UsageError(
      "Не найден API-ключ KIE.\n" +
        "  1) Установите переменную окружения: export KIE_API_KEY=ваш_ключ\n" +
        "  2) Или сохраните ключ: velsgenerate config --set-key ваш_ключ\n" +
        "  3) Или пройдите мастер настройки: velsgenerate setup\n" +
        "Ключ выдаётся в кабинете https://kie.ai"
    );
  }
  return new KieClient(key);
}

/** Каскад jobs → veo → suno → gpt4o → flux → runway, пока задача не найдётся. */
async function detectApi(client, taskId) {
  for (const api of CASCADE_ORDER) {
    try {
      return { api, status: await client.status(api, taskId) };
    } catch (exc) {
      if (!(exc instanceof TaskNotFound)) throw exc;
    }
  }
  throw new UsageError(
    `Задача ${taskId} не найдена ни в одном API. Укажите тип явно: --api ${APIS.join("|")}`
  );
}

/** Polling до терминального статуса. success → статус; fail/timeout → KieError. */
async function pollUntilDone(client, api, taskId, timeoutSec, intervalSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastState = null;
  for (;;) {
    const status = await client.status(api, taskId);
    if (status.state !== lastState) {
      console.error(`Статус: ${status.state}`);
      lastState = status.state;
    }
    if (status.state === "success") return status;
    if (status.state === "fail") throw new KieError(status.fail_msg || "генерация не удалась");
    if (Date.now() >= deadline) {
      throw new KieError(
        `таймаут ожидания (${timeoutSec} сек). Задача ещё выполняется — ` +
          `проверьте позже: velsgenerate wait ${taskId}`
      );
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

function urlFilename(url, fallback) {
  try {
    const name = path.basename(new URL(url).pathname);
    return name || fallback;
  } catch {
    return fallback;
  }
}

/** Скачивает resultUrls в каталог. Возвращает список путей. */
async function downloadResults(urls, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const saved = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    let dest = path.join(directory, urlFilename(url, `result_${i + 1}`));
    const ext = path.extname(dest);
    const base = dest.slice(0, dest.length - ext.length);
    let n = 1;
    while (fs.existsSync(dest)) dest = `${base}_${n++}${ext}`;
    console.error(`Скачивание ${url} -> ${dest}`);
    await downloadFile(url, dest);
    saved.push(dest);
  }
  return saved;
}

function emit(flags, payload, human) {
  if (flags["--json"]) console.log(JSON.stringify(payload, null, 2));
  else human();
}

function printStatusHuman(status) {
  console.log(`Состояние: ${status.state}`);
  if (status.progress !== null && status.progress !== undefined) {
    console.log(`Прогресс: ${status.progress}`);
  }
  if (status.state === "success") {
    if (status.tracks && status.tracks.length > 0) {
      status.tracks.forEach((track, i) => {
        console.log(`Трек ${i + 1}:`);
        if (track.audioUrl) console.log(`  audioUrl:       ${track.audioUrl}`);
        if (track.streamAudioUrl) console.log(`  streamAudioUrl: ${track.streamAudioUrl}`);
      });
    } else if (status.urls && status.urls.length > 0) {
      console.log("Результаты:");
      for (const url of status.urls) console.log(`  ${url}`);
    } else {
      console.log("URL результата не найдены, сырой ответ:");
      console.log(JSON.stringify(status.raw, null, 2));
    }
  } else if (status.state === "fail") {
    console.log(`Ошибка генерации: ${status.fail_msg}`);
  }
}

function warn(message) {
  console.error(`Предупреждение: ${message}`);
}

// ------------------------------------------------------------------ commands
async function cmdCredits(flags) {
  const client = makeClient();
  const credits = await client.credits();
  emit(flags, { credits }, () => console.log(`Баланс: ${credits} кредитов`));
  return 0;
}

async function cmdModels(flags) {
  const registry = await loadRegistry({
    refresh: Boolean(flags["--refresh"]),
    allowFetch: true,
    onWarning: warn,
  });
  let items = [...registry.models.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (flags["--category"]) items = items.filter(([, m]) => m.category === flags["--category"]);
  if (flags["--search"]) {
    const needle = String(flags["--search"]).toLowerCase();
    items = items.filter(
      ([id, m]) => id.toLowerCase().includes(needle) || (m.description || "").toLowerCase().includes(needle)
    );
  }
  const payload = {
    source: registry.source,
    fetchedAt: registry.fetchedAt,
    count: items.length,
    models: items.map(([id, m]) => ({
      id,
      category: m.category,
      api: m.api,
      required: m.required,
      prompt_field: m.prompt_field,
      image_field: m.image_field,
      stale: Boolean(m.stale),
      dynamic: Boolean(m.dynamic),
      docUrl: m.docUrl || null,
      description: m.description,
    })),
  };

  const human = () => {
    const date = registry.fetchedAt ? registry.fetchedAt.slice(0, 10) : "встроенный";
    console.log(`Источник: ${registry.source} (каталог от ${date}), моделей: ${items.length}`);
    if (items.length === 0) {
      console.log("Модели не найдены.");
      return;
    }
    for (const [id, m] of items) {
      const required = (m.required && m.required.length > 0) ? m.required.join(", ") : "—";
      const stale = m.stale ? "  [stale: нет в живом каталоге]" : "";
      console.log(`${id}  [${m.category}/${m.api}]  обязательные: ${required}${stale}`);
      if (m.description) console.log(`    ${m.description}`);
      if (m.docUrl) console.log(`    схема input: velsgenerate schema ${id}  (${m.docUrl})`);
    }
  };
  emit(flags, payload, human);
  return 0;
}

function formatUsd(value) {
  return `$${value >= 0.1 ? value.toFixed(2) : value.toFixed(3)}`;
}

function formatPriceRange(pricing) {
  if (!pricing) return "цена неизвестна";
  const credits = pricing.creditsMin === pricing.creditsMax
    ? `${pricing.creditsMin}`
    : `${pricing.creditsMin}–${pricing.creditsMax}`;
  const usd = pricing.usdMin === pricing.usdMax
    ? formatUsd(pricing.usdMin)
    : `${formatUsd(pricing.usdMin)}–${formatUsd(pricing.usdMax)}`;
  const units = pricing.units.length > 0 ? ` ${pricing.units.join("/")}` : "";
  const approx = pricing.approximate ? "≈" : "";
  return `${approx}${credits} кредитов${units} (~${usd})`;
}

async function cmdPricing(flags) {
  const pricing = await loadPricing({
    refresh: Boolean(flags["--refresh"]),
    allowFetch: true,
    onWarning: warn,
  });
  let records = pricing.records;
  if (flags["--category"]) records = records.filter((r) => r.category === flags["--category"]);
  if (flags["--search"]) {
    // Сравнение без дефисов/пробелов: "nano-banana" находит "Google nano banana 2".
    const needle = String(flags["--search"]).toLowerCase().replace(/[^a-z0-9а-яё]+/g, "");
    const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9а-яё]+/g, "");
    records = records.filter(
      (r) => squash(r.id || "").includes(needle) || squash(r.description).includes(needle)
    );
  }
  const payload = {
    source: pricing.source,
    fetchedAt: pricing.fetchedAt,
    count: records.length,
    prices: records,
  };
  const human = () => {
    const date = pricing.fetchedAt ? pricing.fetchedAt.slice(0, 10) : "—";
    console.log(`Источник: ${pricing.source} (прайс от ${date}), записей: ${records.length}`);
    if (records.length === 0) {
      console.log("Записи не найдены. Попробуйте: velsgenerate pricing --refresh");
      return;
    }
    for (const r of records) {
      console.log(`${r.id || r.description}  [${r.category}]  ${r.credits} кредитов ${r.unit} (~${formatUsd(r.usd)})`);
      if (r.id && r.description) console.log(`    ${r.description}`);
    }
  };
  emit(flags, payload, human);
  return 0;
}

const TIER_LABELS = {
  quality: "максимальное качество",
  balanced: "баланс цена/качество",
  budget: "бюджетно, для объёма",
};

async function cmdRecommend(flags, positionals) {
  const category = positionals[0];
  if (!category || !CATEGORIES.includes(category)) {
    throw new UsageError(`Укажите категорию: velsgenerate recommend ${CATEGORIES.join("|")}`);
  }
  const registry = await loadRegistry({
    refresh: Boolean(flags["--refresh"]),
    allowFetch: true,
    onWarning: warn,
  });
  const pricing = await loadPricing({
    refresh: Boolean(flags["--refresh"]),
    allowFetch: true,
    onWarning: warn,
  });
  const options = recommend(category, registry.models, pricing.records);
  const payload = {
    category,
    pricingSource: pricing.source,
    pricingFetchedAt: pricing.fetchedAt,
    options,
  };
  const human = () => {
    if (options.length === 0) {
      console.log(`Моделей категории ${category} не найдено. Обновите каталог: velsgenerate models --refresh`);
      return;
    }
    console.log(`Рекомендуемые модели (${category}) — последняя версия каждого популярного семейства:`);
    options.forEach((option, i) => {
      const tier = option.tier ? `  [${TIER_LABELS[option.tier]}]` : "";
      console.log(`${i + 1}. ${option.model}${tier}`);
      console.log(`   ${formatPriceRange(option.pricing)}`);
      if (option.description) console.log(`   ${option.description}`);
    });
    console.log("\nЗапуск: velsgenerate run МОДЕЛЬ --prompt ... --wait --download ./out --json");
  };
  emit(flags, payload, human);
  return 0;
}

/** Предполагаемый адрес страницы модели в market-каталоге (для моделей вне реестра). */
function guessDocUrl(modelId) {
  return `https://docs.kie.ai/market/${modelId}.md`;
}

/**
 * Дополняет запись реестра метаданными из живой схемы модели (кэш 24ч).
 * Это то, что позволяет новой модели каталога работать без обновления CLI:
 * поля промпта/изображения, обязательные поля и их дефолты берутся из документации.
 */
async function withLiveSchema(model, modelId, flags) {
  if (flags["--no-schema"]) return model;
  const docUrl = model.docUrl || guessDocUrl(modelId);
  const schema = await loadModelSchema(docUrl, { refresh: Boolean(flags["--refresh-schema"]) });
  if (!schema) {
    if (model.dynamic || !model.docUrl) {
      warn(
        `схема модели ${modelId} недоступна — поля не проверены. ` +
          "Если API вернёт 422, сверьтесь с документацией: velsgenerate schema " + modelId
      );
    }
    return model;
  }
  return mergeModelMeta(model, schema.meta);
}

async function cmdSchema(flags, positionals) {
  const modelId = positionals[0];
  if (!modelId) throw new UsageError("Укажите модель: velsgenerate schema МОДЕЛЬ");
  const registry = await loadRegistry({ allowFetch: true, onWarning: warn });
  const entry = registry.models.get(modelId);
  if (!entry) {
    throw new UsageError(
      `Неизвестная модель: ${JSON.stringify(modelId)}.\n` +
        `Поиск: velsgenerate models --search ${modelId.split("/").pop()}`
    );
  }
  const docUrl = entry.docUrl || null;
  if (!docUrl) {
    throw new UsageError(
      `Для модели ${modelId} нет страницы в живом каталоге docs.kie.ai` +
        (entry.stale ? " (модель помечена stale — вероятно, снята с публикации)." : ".") +
        "\nОбновите каталог: velsgenerate models --refresh"
    );
  }

  let markdown;
  try {
    markdown = await fetchDoc(docUrl);
  } catch (exc) {
    throw new KieError(`не удалось скачать ${docUrl}: ${exc.message}`);
  }
  const { fields, block } = extractInputSchema(markdown);

  const payload = {
    id: modelId,
    api: entry.api,
    category: entry.category,
    docUrl,
    fields,
    raw: flags["--raw"] ? block : undefined,
  };

  const human = () => {
    console.log(`${modelId}  [${entry.category}/${entry.api}]  ${docUrl}`);
    if (fields.length === 0) {
      console.log("Не удалось разобрать схему — откройте страницу документации выше.");
      return;
    }
    console.log("Поля input (* — обязательное):");
    const width = Math.max(...fields.map((f) => f.name.length));
    for (const field of fields) {
      const name = (field.name + (field.required ? "*" : "")).padEnd(width + 1);
      const meta = formatField(field);
      console.log(`  ${name}  ${meta}`);
      if (field.description) console.log(`      ${field.description.slice(0, 300)}`);
    }
    console.log("\nПередача значений: --set ПОЛЕ=ЗНАЧЕНИЕ (JSON или строка), файлы — путь или URL.");
    if (flags["--raw"] && block) console.log(`\n--- сырой YAML схемы ---\n${block}`);
  };
  emit(flags, payload, human);
  return 0;
}

async function cmdUpload(flags, positionals) {
  const file = positionals[0];
  if (!file) throw new UsageError("Укажите файл: velsgenerate upload ФАЙЛ");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new UsageError(`Файл не найден: ${file}`);
  }
  const client = makeClient();
  const url = await client.upload(file);
  emit(flags, { fileUrl: url }, () => console.log(url));
  return 0;
}

async function cmdRun(flags, positionals) {
  const modelId = positionals[0];
  if (!modelId) throw new UsageError("Укажите модель: velsgenerate run МОДЕЛЬ [--prompt ...]");
  // Без сети на каждый запуск: только кэш/seed (allowFetch: false).
  let registry = await loadRegistry({ allowFetch: false, onWarning: warn });
  // Модели нет в кэше — возможно, она появилась в каталоге только что: обновляемся.
  if (!registry.models.has(modelId) && !flags["--api"]) {
    registry = await loadRegistry({ refresh: true, allowFetch: true, onWarning: warn });
  }
  const registryEntry = resolveModel(modelId, flags["--api"] || null, registry.models);
  const model = await withLiveSchema(registryEntry, modelId, flags);
  const data = buildInput(model, {
    prompt: flags["--prompt"] ?? null,
    images: flags["--image"],
    setPairs: flags["--set"],
    jsonInputStr: flags["--json-input"],
  });
  validateInput(model, data); // до любых сетевых вызовов

  if (flags["--dry-run"]) {
    const payload = {
      dryRun: true,
      model: modelId,
      api: model.api,
      input: data,
      uploads: Object.entries(data)
        .flatMap(([field, value]) => (Array.isArray(value) ? value : [value]).map((v) => [field, v]))
        .filter(([, value]) => isLocalFile(value))
        .map(([field, value]) => ({ field, file: value })),
    };
    emit(flags, payload, () => {
      console.log(`${modelId} (api: ${model.api}) — запрос не отправлен (--dry-run)`);
      console.log(JSON.stringify(data, null, 2));
      for (const u of payload.uploads) console.log(`Будет загружен: ${u.file} → ${u.field}`);
    });
    return 0;
  }

  const client = makeClient();
  await resolveLocalFiles(client, model, data);
  const taskId = await client.create(model.api, modelId, data);

  const payload = { taskId, model: modelId, api: model.api };

  const humanCreated = () => {
    console.log("Задача создана.");
    console.log(`  taskId: ${taskId}`);
    console.log(`  модель: ${modelId} (api: ${model.api})`);
    console.log(`Проверить статус:     velsgenerate status ${taskId}`);
    console.log(`Дождаться результата: velsgenerate wait ${taskId}`);
  };

  if (!flags["--wait"]) {
    emit(flags, payload, humanCreated);
    return 0;
  }

  const timeout = Number(flags["--timeout"] ?? 600);
  const interval = Number(flags["--interval"] ?? 5);
  const status = await pollUntilDone(client, model.api, taskId, timeout, interval);
  payload.status = {
    state: status.state,
    urls: status.urls,
    tracks: status.tracks,
    fail_msg: status.fail_msg,
  };
  if (flags["--download"] && status.urls.length > 0) {
    payload.files = await downloadResults(status.urls, flags["--download"]);
  }

  const humanDone = () => {
    printStatusHuman(status);
    for (const file of payload.files || []) console.log(`Сохранено: ${file}`);
  };
  emit(flags, payload, humanDone);
  return 0;
}

async function cmdStatus(flags, positionals) {
  const taskId = positionals[0];
  if (!taskId) throw new UsageError("Укажите taskId: velsgenerate status TASK_ID");
  const client = makeClient();
  let status;
  if (flags["--api"]) {
    status = await client.status(flags["--api"], taskId);
  } else {
    const detected = await detectApi(client, taskId);
    status = detected.status;
    if (!flags["--json"]) console.error(`API: ${detected.api} (определён автоматически)`);
  }
  emit(flags, status, () => printStatusHuman(status));
  return status.state === "fail" ? 1 : 0;
}

async function cmdWait(flags, positionals) {
  const taskId = positionals[0];
  if (!taskId) throw new UsageError("Укажите taskId: velsgenerate wait TASK_ID");
  const client = makeClient();
  let api = flags["--api"];
  if (!api) {
    const detected = await detectApi(client, taskId);
    api = detected.api;
    if (!flags["--json"]) console.error(`API: ${api} (определён автоматически)`);
  }
  const timeout = Number(flags["--timeout"] ?? 600);
  const interval = Number(flags["--interval"] ?? 5);
  const status = await pollUntilDone(client, api, taskId, timeout, interval);
  emit(flags, status, () => printStatusHuman(status));
  return 0;
}

async function cmdDownload(flags, positionals) {
  const url = positionals[0];
  if (!url) throw new UsageError("Укажите URL: velsgenerate download URL [-o ПУТЬ]");
  let dest = flags["--output"];
  if (!dest) dest = urlFilename(url, "download");
  if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
    dest = path.join(dest, urlFilename(url, "download"));
  }
  await downloadFile(url, dest);
  emit(flags, { file: dest }, () => console.log(`Сохранено: ${dest}`));
  return 0;
}

function cmdConfig(flags) {
  const key = flags["--set-key"];
  if (!key) throw new UsageError("Укажите ключ: velsgenerate config --set-key ВАШ_КЛЮЧ");
  saveApiKey(key);
  emit(flags, { config: CONFIG_PATH }, () => console.log(`Ключ сохранён в ${CONFIG_PATH}`));
  return 0;
}

// ------------------------------------------------------------------ help
const HELP = `VelsGenerate ${VERSION} — генерация фото/видео/аудио через KIE API (kie.ai).

Использование: velsgenerate <команда> [флаги]

Команды:
  setup        мастер первичной настройки (ключ + скилл агента), alias: init
                 флаги: --yes (неинтерактивно), --local (скилл из пакета), --repo РЕПО
  credits      баланс кредитов
  models       реестр моделей (живой каталог docs.kie.ai, кэш 24ч)
                 флаги: --refresh, --category image|video|audio, --search ТЕКСТ
  pricing      цены моделей в кредитах и $ (kie.ai/pricing, кэш 24ч)
                 флаги: --refresh, --category image|video|audio, --search ТЕКСТ
  recommend    подбор модели под категорию: последняя версия каждого
    КАТЕГОРИЯ    популярного семейства с ценами и тиром качества
                 (image|video|audio), флаги: --refresh
  schema МОДЕЛЬ поля input модели из её документации (--raw — сырой YAML)
  upload ФАЙЛ  загрузить локальный файл, напечатать fileUrl
  run МОДЕЛЬ   создать задачу генерации
                 --prompt ТЕКСТ        промпт (кладётся в prompt_field модели)
                 --image ФАЙЛ_ИЛИ_URL  изображение; можно несколько раз
                 --set КЛЮЧ=ЗНАЧЕНИЕ   поле input; значение парсится как JSON
                                       (локальный файл в любом поле загружается сам)
                 --json-input 'JSON'   сырой JSON-объект поверх собранного input
                 --api ТИП             jobs|veo|runway|gpt4o|flux|suno (для моделей вне реестра)
                 --dry-run             показать итоговый input и не отправлять запрос
                 --no-schema           не подтягивать схему модели из документации
                 --refresh-schema      обновить кэш схемы модели
                 --wait                дождаться результата (polling)
                 --timeout СЕК         таймаут --wait (по умолч. 600)
                 --interval СЕК        интервал polling (по умолч. 5)
                 --download КАТАЛОГ    скачать результаты (с --wait)
  status ID    статус задачи; без --api — автоперебор: ${CASCADE_ORDER.join(" → ")}
  wait ID      дождаться завершения задачи (--timeout 600 --interval 5)
  download URL скачать файл (-o ПУТЬ)
  config       сохранить ключ: --set-key KEY

Общий флаг: --json — машинный вывод в JSON.
Ключ API: env KIE_API_KEY или ${CONFIG_PATH}`;

// ------------------------------------------------------------------ dispatch
const COMMAND_SPECS = {
  setup: { bool: ["--json", "--yes", "--local"], value: ["--repo"], handler: (f) => runSetup(f) },
  init: { bool: ["--json", "--yes", "--local"], value: ["--repo"], handler: (f) => runSetup(f) },
  credits: { bool: ["--json"], handler: cmdCredits },
  models: {
    bool: ["--json", "--refresh"],
    value: ["--category", "--search"],
    handler: cmdModels,
  },
  pricing: {
    bool: ["--json", "--refresh"],
    value: ["--category", "--search"],
    handler: cmdPricing,
  },
  recommend: { bool: ["--json", "--refresh"], handler: cmdRecommend },
  schema: { bool: ["--json", "--raw"], handler: cmdSchema },
  upload: { bool: ["--json"], handler: cmdUpload },
  run: {
    bool: ["--json", "--wait", "--no-schema", "--refresh-schema", "--dry-run"],
    value: ["--prompt", "--json-input", "--api", "--timeout", "--interval", "--download"],
    multi: ["--image", "--set"],
    handler: cmdRun,
  },
  status: { bool: ["--json"], value: ["--api"], handler: cmdStatus },
  wait: { bool: ["--json"], value: ["--api", "--timeout", "--interval"], handler: cmdWait },
  download: { bool: ["--json"], value: ["--output"], alias: { "-o": "--output" }, handler: cmdDownload },
  config: { bool: ["--json"], value: ["--set-key"], handler: cmdConfig },
};

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return 0;
  }
  if (argv[0] === "--version") {
    console.log(`velsgenerate ${VERSION}`);
    return 0;
  }
  const [command, ...rest] = argv;
  const spec = COMMAND_SPECS[command];
  if (!spec) {
    console.error(`Ошибка: неизвестная команда: ${command}\n`);
    console.error(HELP);
    return 2;
  }
  try {
    const { flags, positionals } = parseArgs(rest, spec);
    return (await spec.handler(flags, positionals)) || 0;
  } catch (exc) {
    if (exc instanceof UsageError) {
      console.error(`Ошибка: ${exc.message}`);
      return 2;
    }
    if (exc instanceof TaskNotFound) {
      console.error(`Задача не найдена: ${exc.msg}`);
      return 1;
    }
    if (exc instanceof KieError) {
      console.error(exc.message);
      return 1;
    }
    throw exc;
  }
}
