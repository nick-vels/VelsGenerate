import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractModelId,
  normalizeRecord,
  loadPricing,
  priceForModel,
  USD_PER_CREDIT,
} from "../src/pricing.js";
import { familyOf, recommend } from "../src/recommend.js";

const RAW_RECORD = {
  modelDescription: "Google nano banana 2, 1K",
  interfaceType: "image",
  provider: "Google",
  creditPrice: "8",
  creditUnit: "per image",
  usdPrice: "0.04",
  anchor: "https://kie.ai/nano-banana?model=google%2Fnano-banana-2",
  discountRate: 20.0,
};

test("extractModelId: id из query-параметра model", () => {
  assert.equal(extractModelId(RAW_RECORD.anchor), "google/nano-banana-2");
  assert.equal(extractModelId("https://kie.ai/page"), null);
  assert.equal(extractModelId(null), null);
});

test("normalizeRecord: категория, числа, fallback курса usd", () => {
  const record = normalizeRecord(RAW_RECORD);
  assert.equal(record.id, "google/nano-banana-2");
  assert.equal(record.category, "image");
  assert.equal(record.credits, 8);
  assert.equal(record.usd, 0.04);
  assert.equal(record.unit, "per image");

  // music → audio; без usdPrice — пересчёт по курсу
  const audio = normalizeRecord({ ...RAW_RECORD, interfaceType: "music", usdPrice: "", creditPrice: "10" });
  assert.equal(audio.category, "audio");
  assert.equal(audio.usd, 10 * USD_PER_CREDIT);

  // chat и битые цены пропускаем
  assert.equal(normalizeRecord({ ...RAW_RECORD, interfaceType: "chat" }), null);
  assert.equal(normalizeRecord({ ...RAW_RECORD, creditPrice: "n/a" }), null);
});

function tmpCache() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vels-pricing-")), "cache.json");
}

test("loadPricing: сеть → кэш; при сбое сети — старый кэш", async () => {
  const cachePath = tmpCache();
  const page = { records: [RAW_RECORD], total: 1 };
  const live = await loadPricing({
    cachePath,
    fetchImpl: async () => page,
  });
  assert.equal(live.source, "live");
  assert.equal(live.records.length, 1);

  // свежий кэш — сеть не вызывается
  const cached = await loadPricing({
    cachePath,
    fetchImpl: async () => {
      throw new Error("сеть недоступна");
    },
  });
  assert.equal(cached.source, "cache");
  assert.equal(cached.records.length, 1);

  // протухший кэш + сбой сети + refresh → старый кэш
  const stale = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  stale.fetchedAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  fs.writeFileSync(cachePath, JSON.stringify(stale));
  const warnings = [];
  const fallback = await loadPricing({
    refresh: true,
    cachePath,
    fetchImpl: async () => {
      throw new Error("сеть недоступна");
    },
    onWarning: (msg) => warnings.push(msg),
  });
  assert.equal(fallback.source, "cache");
  assert.equal(warnings.length, 1);
});

test("loadPricing: без кэша и без сети — пустой список", async () => {
  const result = await loadPricing({
    cachePath: tmpCache(),
    allowFetch: false,
  });
  assert.equal(result.source, "none");
  assert.deepEqual(result.records, []);
});

test("priceForModel: сводка min/max и единиц", () => {
  const records = [
    { id: "m/a", credits: 8, usd: 0.04, unit: "per image", description: "Model A 1K" },
    { id: "m/a", credits: 18, usd: 0.09, unit: "per image", description: "Model A 2K" },
    { id: "m/b", credits: 1, usd: 0.005, unit: "per second", description: "Model B" },
  ];
  assert.deepEqual(priceForModel(records, "m/a"), {
    creditsMin: 8,
    creditsMax: 18,
    usdMin: 0.04,
    usdMax: 0.09,
    units: ["per image"],
    approximate: false,
  });
  assert.equal(priceForModel(records, "m/unknown"), null);
});

test("priceForModel: нечёткий матч по токенам описания", () => {
  // У записей прайса нет id (anchor без ?model=), только описание.
  const records = [
    { id: null, credits: 150, usd: 0.75, unit: "per video", description: "Google veo 3.1, text-to-video, Quality-4K" },
    { id: null, credits: 30, usd: 0.15, unit: "per video", description: "Google veo 3.1, image-to-video, Lite-720p" },
    { id: null, credits: 18, usd: 0.09, unit: "per image", description: "Google nano banana 2, 4K" },
  ];
  const veo = priceForModel(records, "veo3");
  assert.equal(veo.approximate, true);
  assert.equal(veo.creditsMin, 30);
  assert.equal(veo.creditsMax, 150);
  // "nano-banana-2" не сматчится на veo, "google/nano-banana-2" — сматчится
  assert.equal(priceForModel(records, "google/nano-banana-2").creditsMax, 18);
  // точный id важнее нечёткого: записи с id не смешиваются с чужими описаниями
  const mixed = [...records, { id: "veo3", credits: 100, usd: 0.5, unit: "per video", description: "" }];
  const exact = priceForModel(mixed, "veo3");
  assert.equal(exact.approximate, false);
  assert.equal(exact.creditsMax, 100);
});

test("familyOf: семейство, версия, суффикс", () => {
  assert.deepEqual(familyOf("google/nano-banana-2"), {
    family: "google-nano-banana", version: 2, suffix: "",
  });
  assert.deepEqual(familyOf("bytedance/seedance-2-mini"), {
    family: "bytedance-seedance", version: 2, suffix: "mini",
  });
  assert.deepEqual(familyOf("kling/v2-5-turbo-text-to-video-pro"), {
    family: "kling", version: 2.5, suffix: "turbo-text-to-video-pro",
  });
  assert.deepEqual(familyOf("veo3_fast"), { family: "veo", version: 3, suffix: "fast" });
  assert.deepEqual(familyOf("kling-2.6/text-to-video"), {
    family: "kling", version: 2.6, suffix: "text-to-video",
  });
  assert.deepEqual(familyOf("suno"), { family: "suno", version: 0, suffix: "" });
});

test("recommend: последняя версия семейства, тиры по цене, лимит", () => {
  const registryModels = new Map([
    ["google/nano-banana", { category: "image", description: "v1" }],
    ["google/nano-banana-2", { category: "image", description: "v2" }],
    ["google/nano-banana-2-lite", { category: "image", description: "v2 lite" }],
    ["openai/gpt-image-2", { category: "image", description: "топ" }],
    ["some/obscure-1", { category: "image", description: "никому не известная" }],
    ["old/model-9", { category: "image", description: "снята с публикации", stale: true }],
    ["bytedance/seedance-2", { category: "video", description: "видео" }],
  ]);
  const pricing = [
    { id: "google/nano-banana-2", credits: 8, usd: 0.04, unit: "per image" },
    { id: "google/nano-banana-2-lite", credits: 4, usd: 0.02, unit: "per image" },
    { id: "openai/gpt-image-2", credits: 16, usd: 0.08, unit: "per image" },
  ];
  const options = recommend("image", registryModels, pricing);
  // stale исключён, видео исключено; семейство nano-banana представлено топовой версией
  const ids = options.map((o) => o.model);
  assert.ok(ids.includes("google/nano-banana-2"));
  assert.ok(!ids.includes("google/nano-banana"));
  assert.ok(!ids.includes("old/model-9"));
  assert.ok(!ids.includes("bytedance/seedance-2"));
  // популярные семейства идут раньше малоизвестных
  assert.ok(ids.indexOf("some/obscure-1") > ids.indexOf("google/nano-banana-2"));
  // тиры: самая дорогая — quality, самая дешёвая — budget
  const byId = Object.fromEntries(options.map((o) => [o.model, o]));
  assert.equal(byId["openai/gpt-image-2"].tier, "quality");
  assert.equal(byId["google/nano-banana-2"].tier, "budget");
  assert.equal(byId["some/obscure-1"].tier, null);
  assert.equal(byId["openai/gpt-image-2"].pricing.creditsMax, 16);
});
