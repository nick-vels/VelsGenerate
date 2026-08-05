#!/usr/bin/env node
/**
 * Сверка seed-реестра (src/models.js) с живой документацией docs.kie.ai.
 *
 * Ловит расхождения, из-за которых запрос уходит с неправильными полями:
 * переименованное поле картинки, новые обязательные поля, изменившийся тип,
 * снятые с публикации модели.
 *
 * Запуск: npm run audit:registry
 * Код возврата 1, если найдены расхождения (годится для CI).
 */

import { SEED_MODELS } from "../src/models.js";
import { fetchDoc, loadRegistry } from "../src/registry.js";
import { extractInputSchema } from "../src/schema.js";

const CONCURRENCY = 8;
// CLI дожидается результата polling'ом, callback-адрес не передаёт.
const IGNORED_REQUIRED = new Set(["callBackUrl", "callbackUrl"]);

const registry = await loadRegistry({
  refresh: true,
  allowFetch: true,
  onWarning: (msg) => console.error(`Предупреждение: ${msg}`),
});

const problems = [];
const noDoc = [];
const checked = [];

async function check(id) {
  const entry = registry.models.get(id);
  if (!entry?.docUrl) {
    noDoc.push(id);
    return;
  }
  let markdown;
  try {
    markdown = await fetchDoc(entry.docUrl);
  } catch (exc) {
    problems.push(`${id}: страница недоступна (${exc.message})`);
    return;
  }
  const { fields } = extractInputSchema(markdown);
  if (fields.length === 0) {
    problems.push(`${id}: не удалось разобрать схему (${entry.docUrl})`);
    return;
  }
  const names = new Set(fields.map((f) => f.name));
  const known = [...names].join(", ");

  if (entry.prompt_field && !names.has(entry.prompt_field)) {
    problems.push(`${id}: prompt_field="${entry.prompt_field}" нет в схеме; поля: ${known}`);
  }
  if (entry.image_field && !names.has(entry.image_field)) {
    problems.push(`${id}: image_field="${entry.image_field}" нет в схеме; поля: ${known}`);
  }
  for (const field of entry.required || []) {
    if (!names.has(field)) {
      problems.push(`${id}: required="${field}" нет в схеме; поля: ${known}`);
    }
  }
  for (const field of fields) {
    if (!field.required || IGNORED_REQUIRED.has(field.name)) continue;
    const covered = (entry.required || []).includes(field.name)
      || Object.prototype.hasOwnProperty.call(entry.defaults || {}, field.name);
    if (!covered) {
      problems.push(`${id}: поле "${field.name}" обязательно в доках, но не в seed`);
    }
  }
  if (entry.image_field && names.has(entry.image_field)) {
    const isArray = fields.find((f) => f.name === entry.image_field).type === "array";
    if (isArray !== Boolean(entry.image_list)) {
      problems.push(`${id}: image_list=${Boolean(entry.image_list)}, а в схеме тип ${isArray ? "array" : "string"}`);
    }
  }
  checked.push(id);
}

const queue = Object.keys(SEED_MODELS);
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) await check(queue.shift());
  })
);

console.log(`Сверено моделей: ${checked.length} из ${Object.keys(SEED_MODELS).length}`);
if (noDoc.length > 0) {
  console.log("\nБез страницы в каталоге (кандидаты на удаление из seed):");
  for (const id of noDoc.sort()) console.log(`  ${id}`);
}
if (problems.length > 0) {
  console.log("\nРасхождения:");
  for (const problem of problems.sort()) console.log(`  - ${problem}`);
}
if (problems.length === 0 && noDoc.length === 0) console.log("Расхождений нет.");

process.exit(problems.length > 0 || noDoc.length > 0 ? 1 : 0);
