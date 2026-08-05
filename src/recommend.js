/**
 * Рекомендации моделей: группировка реестра по семействам, выбор топовой
 * (последней) модели семейства и привязка цен из прайс-листа (src/pricing.js).
 *
 * Логика «топовая модель семейства»: максимальная версия; при равной версии —
 * самая дорогая по прайсу (дороже ≈ качественнее), затем базовый вариант
 * (без суффикса mini/lite/fast/...).
 */

import { priceForModel } from "./pricing.js";

/**
 * Известные популярные семейства по категориям, в порядке узнаваемости.
 * Ключ матчится подстрокой по нормализованному имени семейства, поэтому
 * новые версии семейства подхватываются автоматически.
 */
export const POPULAR_FAMILIES = {
  image: ["nano-banana", "gpt-image", "flux", "seedream", "imagen"],
  video: ["seedance", "veo", "kling", "hailuo", "sora", "grok-imagine"],
  audio: ["suno", "elevenlabs"],
};

/**
 * Разбор id модели на семейство/версию/суффикс.
 * "google/nano-banana-2"        → family "google-nano-banana", version 2, suffix ""
 * "bytedance/seedance-2-mini"   → family "bytedance-seedance", version 2, suffix "mini"
 * "kling/v2-5-turbo-…-pro"      → family "kling", version 2.5
 * "veo3_fast"                   → family "veo", version 3, suffix "fast"
 * "suno"                        → family "suno", version 0
 */
export function familyOf(modelId) {
  const norm = String(modelId)
    .toLowerCase()
    .replace(/[/_\s]+/g, "-")
    .replace(/v(?=\d)/g, "");
  const match = /(\d+)(?:[.-](\d+))?/.exec(norm);
  if (!match) return { family: norm, version: 0, suffix: "" };
  const family = norm.slice(0, match.index).replace(/-+$/g, "");
  const minor = match[2] ? Number(match[2]) / 10 ** match[2].length : 0;
  const suffix = norm.slice(match.index + match[0].length).replace(/^-+/g, "");
  return { family, version: Number(match[1]) + minor, suffix };
}

/** Ключ популярного семейства, которому соответствует family (null — семейство не из списка). */
function popularityKey(category, family) {
  const keys = POPULAR_FAMILIES[category] || [];
  return keys.find((key) => family.includes(key)) || null;
}

/** Порядковый индекс семейства в списке популярных (Infinity — семейство не из списка). */
function popularityIndex(category, family) {
  const key = popularityKey(category, family);
  if (key === null) return Infinity;
  return POPULAR_FAMILIES[category].indexOf(key);
}

/** Топовая модель семейства: свежая версия, затем дороже, затем базовый вариант. */
function pickTopModel(candidates, pricingRecords) {
  const decorated = candidates.map(([id, entry]) => {
    const parsed = familyOf(id);
    const price = priceForModel(pricingRecords, id);
    return { id, entry, ...parsed, price, priceMax: price ? price.creditsMax : -1 };
  });
  decorated.sort((a, b) =>
    b.version - a.version ||
    b.priceMax - a.priceMax ||
    a.suffix.length - b.suffix.length ||
    a.id.localeCompare(b.id)
  );
  return decorated[0];
}

/**
 * Рекомендации для категории: топовая модель каждого из самых популярных
 * семейств с ценами. registryModels — Map<id, entry> из loadRegistry,
 * pricingRecords — записи loadPricing. Возвращает до limit вариантов,
 * отсортированных по цене (дорогие = качественнее), с тиром
 * quality|balanced|budget (null, если цена неизвестна).
 */
export function recommend(category, registryModels, pricingRecords, { limit = 4 } = {}) {
  const families = new Map();
  for (const [id, entry] of registryModels) {
    if (entry.category !== category || entry.stale) continue;
    const { family } = familyOf(id);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push([id, entry]);
  }

  const tops = [...families.entries()].map(([family, candidates]) => ({
    family,
    popKey: popularityKey(category, family),
    popularity: popularityIndex(category, family),
    top: pickTopModel(candidates, pricingRecords),
  }));

  tops.sort((a, b) =>
    a.popularity - b.popularity ||
    b.top.version - a.top.version ||
    b.top.priceMax - a.top.priceMax ||
    a.family.localeCompare(b.family)
  );

  // Одно популярное семейство — один слот: живой каталог и seed могут давать
  // одно семейство под разными id ("nano-banana-2" и "google/nano-banana").
  const seenKeys = new Set();
  const deduped = tops.filter(({ popKey }) => {
    if (popKey === null) return true;
    if (seenKeys.has(popKey)) return false;
    seenKeys.add(popKey);
    return true;
  });

  const chosen = deduped.slice(0, limit).map(({ family, top }) => ({
    family,
    model: top.id,
    description: top.entry.description || "",
    pricing: top.price
      ? {
          creditsMin: top.price.creditsMin,
          creditsMax: top.price.creditsMax,
          usdMin: top.price.usdMin,
          usdMax: top.price.usdMax,
          units: top.price.units,
          approximate: top.price.approximate,
        }
      : null,
  }));

  // Тиры по цене: самый дорогой — quality, самый дешёвый — budget, остальные — balanced.
  const priced = chosen.filter((c) => c.pricing);
  for (const option of chosen) option.tier = null;
  if (priced.length > 0) {
    const byPrice = [...priced].sort((a, b) => b.pricing.creditsMax - a.pricing.creditsMax);
    byPrice[0].tier = "quality";
    if (byPrice.length > 1) byPrice[byPrice.length - 1].tier = "budget";
    for (const option of byPrice.slice(1, -1)) option.tier = "balanced";
  }
  return chosen;
}
