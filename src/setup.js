/**
 * velsgenerate setup (alias init) — интерактивный мастер первичной настройки:
 * 1) API-ключ KIE (проверка через credits, сохранение в ~/.velsgenerate/config.json);
 * 2) установка скилла generate для агента (npx skills add <repo> или --local — копия из пакета);
 * 3) сводка и подсказки.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { KieClient, KieError } from "./client.js";
import { getApiKey, saveApiKey } from "./cli.js";

// Репозиторий скилла для `npx skills add <repo>`.
export const SKILLS_REPO = "nick-vels/VelsGenerate";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SKILL_DIR = path.join(PACKAGE_ROOT, "skills", "generate");

function createAsker(interactive) {
  if (!interactive) {
    return { ask: async () => "", askSecret: async () => "", close: () => {} };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (question) => new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
  // Ввод секрета: эхо маскируется звёздочками (и при наборе, и при вставке).
  const askSecret = (question) =>
    new Promise((resolve) => {
      const original = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (chunk) => {
        if (chunk.includes(question) || chunk === "\r\n" || chunk === "\n") original(chunk);
        else original("*");
      };
      rl.question(question, (a) => {
        rl._writeToOutput = original;
        resolve(a.trim());
      });
    });
  return { ask, askSecret, close: () => rl.close() };
}

async function askYesNo(ask, question, defaultYes = true) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${suffix} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes" || answer === "д" || answer === "да";
}

/** Проверка ключа через credits. Возвращает { ok, credits, invalid } . */
async function validateKey(key) {
  try {
    const credits = await new KieClient(key).credits();
    return { ok: true, credits, invalid: false };
  } catch (exc) {
    if (exc instanceof KieError && exc.code === 401) return { ok: false, credits: null, invalid: true };
    return { ok: false, credits: null, invalid: false, error: exc.message };
  }
}

async function stepApiKey({ asker, interactive, yes }) {
  const { ask, askSecret } = asker;
  console.log("\nШаг 1/2. API-ключ KIE");
  const envKey = (process.env.KIE_API_KEY || "").trim();

  let key = null;
  if (yes) {
    // Неинтерактивно: берём только env-ключ.
    if (envKey) {
      key = envKey;
      console.log("  Найден KIE_API_KEY в окружении — использую его.");
    } else {
      console.log("  KIE_API_KEY не задан в окружении — ключ не сохранён.");
      console.log("  Задайте позже: export KIE_API_KEY=ваш_ключ");
      console.log("  или: velsgenerate config --set-key ваш_ключ");
      return { saved: false, credits: null };
    }
  } else {
    if (envKey) {
      const useEnv = await askYesNo(ask, "  Найден KIE_API_KEY в окружении. Использовать его?", true);
      if (useEnv) key = envKey;
    }
    while (!key) {
      key = await askSecret("  Введите API ключ KIE (https://kie.ai/api-key): ");
      if (!key) {
        const abort = !(await askYesNo(ask, "  Ключ не введён. Попробовать ещё раз?", true));
        if (abort) {
          console.log("  Пропускаю. Сохранить позже: velsgenerate config --set-key ваш_ключ");
          return { saved: false, credits: null };
        }
      }
    }
  }

  process.stdout.write("  Проверяю ключ (запрос баланса)... ");
  const check = await validateKey(key);
  if (check.ok) {
    console.log(`OK, баланс: ${check.credits} кредитов.`);
  } else if (check.invalid) {
    console.log("ключ невалиден (401).");
    if (!yes && interactive && (await askYesNo(ask, "  Повторить ввод ключа?", true))) {
      return stepApiKey({ asker, interactive, yes: false });
    }
    console.log("  Ключ НЕ сохранён. Повторите: velsgenerate setup");
    return { saved: false, credits: null };
  } else {
    console.log(`не удалось проверить (${check.error || "сеть недоступна"}).`);
    console.log("  Сохраняю ключ без проверки — проверьте позже: velsgenerate credits");
  }

  saveApiKey(key);
  console.log(`  Ключ сохранён (chmod 600).`);
  return { saved: true, credits: check.credits };
}

function installSkillLocal() {
  const dest = path.join(process.cwd(), ".agents", "skills", "generate");
  if (!fs.existsSync(BUNDLED_SKILL_DIR)) {
    console.log(`  Бандл скилла не найден в пакете: ${BUNDLED_SKILL_DIR}`);
    return null;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(BUNDLED_SKILL_DIR, dest, { recursive: true });
  return dest;
}

function npxAvailable() {
  const result = spawnSync("npx", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

async function stepSkill({ asker, interactive, yes, local, repo }) {
  const { ask } = asker;
  console.log("\nШаг 2/2. Скилл generate для агента");
  const manual = `npx -y skills add ${repo}`;

  if (local) {
    const dest = installSkillLocal();
    if (dest) {
      console.log(`  Скилл скопирован из пакета в ${dest}`);
      return { installed: true, how: "local", dest };
    }
    console.log(`  Установите вручную: ${manual}`);
    return { installed: false, how: null };
  }

  let want = true;
  if (!yes && interactive) {
    want = await askYesNo(ask, "  Установить скилл generate для агента?", true);
  }

  if (want && !yes && interactive && npxAvailable()) {
    console.log(`  Запускаю: ${manual}`);
    const result = spawnSync("npx", ["-y", "skills", "add", repo], { stdio: "inherit" });
    if (result.status === 0) return { installed: true, how: "npx" };
    console.log("  Установка через npx не удалась.");
  }

  // Отказ, неинтерактивный режим без --local, или npx недоступен — печатаем команду.
  console.log("  Установите скилл вручную:");
  console.log(`    ${manual}`);
  console.log("  или локально из пакета: velsgenerate setup --local");
  return { installed: false, how: null };
}

/**
 * Мастер настройки. Флаги: --yes (неинтерактивно), --local, --repo РЕПО.
 */
export async function runSetup(flags = {}) {
  const yes = Boolean(flags["--yes"]);
  const local = Boolean(flags["--local"]);
  const repo = flags["--repo"] || process.env.VELSGENERATE_SKILLS_REPO || SKILLS_REPO;
  const interactive = !yes && Boolean(process.stdin.isTTY);

  console.log("VelsGenerate — первичная настройка");
  if (!yes && !interactive) {
    console.log("(stdin не интерактивен — работаю как --yes: без вопросов)");
  }

  const asker = createAsker(interactive);
  let keyResult, skillResult;
  try {
    keyResult = await stepApiKey({ asker, interactive, yes: yes || !interactive });
    skillResult = await stepSkill({ asker, interactive, yes: yes || !interactive, local, repo });
  } finally {
    asker.close();
  }

  console.log("\nГотово. Сводка:");
  console.log(`  API-ключ:     ${keyResult.saved ? "сохранён в ~/.velsgenerate/config.json" : "не сохранён"}`);
  if (keyResult.credits !== null && keyResult.credits !== undefined) {
    console.log(`  Баланс:       ${keyResult.credits} кредитов`);
  }
  console.log(
    `  Скилл:        ${skillResult.installed ? `установлен (${skillResult.how})` : "не установлен — команда выше"}`
  );
  console.log("\nДальше:");
  console.log("  velsgenerate models                 # живой реестр моделей");
  console.log('  velsgenerate run google/nano-banana --prompt "рыжий кот в скафандре" \\');
  console.log("    --wait --download ./out           # первая генерация");
  return 0;
}
