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
import { loadRegistry } from "./registry.js";
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
  if (entry) return { ...entry };
  if (apiOverride) return { ...GENERIC_MODEL, api: apiOverride };
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
    if (!imageField) throw new UsageError("Эта модель не принимает изображения (--image).");
    if (model.image_list) {
      data[imageField] = [...images];
    } else {
      if (images.length > 1) {
        throw new UsageError(`Поле ${imageField} принимает одно изображение, передано: ${images.length}.`);
      }
      data[imageField] = images[0];
    }
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
    throw new UsageError("Не заполнены обязательные поля модели:\n" + lines.join("\n"));
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

/** Заменяет локальные пути в image-поле на URL после upload. */
async function resolveImages(client, model, data) {
  const imageField = model.image_field;
  if (!imageField || !(imageField in data)) return;

  const resolve = async (value) => {
    if (typeof value !== "string") return value;
    if (value.startsWith("http://") || value.startsWith("https://")) return value;
    if (fs.existsSync(value) && fs.statSync(value).isFile()) {
      console.error(`Загрузка файла ${value} ...`);
      const url = await client.upload(value);
      console.error(`  -> ${url}`);
      return url;
    }
    throw new UsageError(`--image: не файл и не URL: ${value}`);
  };

  if (model.image_list && Array.isArray(data[imageField])) {
    data[imageField] = await Promise.all(data[imageField].map(resolve));
  } else {
    data[imageField] = await resolve(data[imageField]);
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
    }
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
  const registry = await loadRegistry({ allowFetch: false, onWarning: warn });
  const model = resolveModel(modelId, flags["--api"] || null, registry.models);
  const data = buildInput(model, {
    prompt: flags["--prompt"] ?? null,
    images: flags["--image"],
    setPairs: flags["--set"],
    jsonInputStr: flags["--json-input"],
  });
  validateInput(model, data); // до любых сетевых вызовов
  const client = makeClient();
  await resolveImages(client, model, data);
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
  upload ФАЙЛ  загрузить локальный файл, напечатать fileUrl
  run МОДЕЛЬ   создать задачу генерации
                 --prompt ТЕКСТ        промпт (кладётся в prompt_field модели)
                 --image ФАЙЛ_ИЛИ_URL  изображение; можно несколько раз
                 --set КЛЮЧ=ЗНАЧЕНИЕ   поле input; значение парсится как JSON
                 --json-input 'JSON'   сырой JSON-объект поверх собранного input
                 --api ТИП             jobs|veo|runway|gpt4o|flux|suno (для моделей вне реестра)
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
  upload: { bool: ["--json"], handler: cmdUpload },
  run: {
    bool: ["--json", "--wait"],
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
