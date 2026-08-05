import test from "node:test";
import assert from "node:assert/strict";

import {
  parseLlmsTxt,
  extractModelIds,
  mergeRegistries,
} from "../src/registry.js";
import { SEED_MODELS } from "../src/models.js";

const LLMS_SAMPLE = `# docs.kie.ai

## Docs
- [Getting Started](https://docs.kie.ai/1973359m0.md):
- Image    Models > 4o Image API [4o Image API Quickstart](https://docs.kie.ai/4o-image-api/quickstart.md):

## API Docs
- Image    Models > Google [Google - Nano Banana](https://docs.kie.ai/market/google/nano-banana.md): Content generation using google/nano-banana
- Image    Models > Seedream [Seedream5.0 Pro - Text to Image](https://docs.kie.ai/market/seedream/5-pro-text-to-image.md): High-quality photorealistic image generation
- Video Models > Kling [Kling 3.0](https://docs.kie.ai/market/kling/v3.md): Video generation by kling-3.0/video
- Music Models > ElevenLabs [elevenlabs/text-to-dialogue-v3](https://docs.kie.ai/market/elevenlabs/text-to-dialogue-v3.md): Dialogue text-to-speech generation
- Chat  Models > Claude [Claude Code Guide](https://docs.kie.ai/market/chat/claude.md): should be skipped
- Image    Models > Google [Nano Banana CN](https://docs.kie.ai/cn/market/google/nano-banana.md): китайская версия
- [Market](https://docs.kie.ai/market/quickstart.md):
- Video Models > Runway API [Runway API Quickstart](https://docs.kie.ai/runway-api/quickstart.md):
`;

test("parseLlmsTxt: категории, пропуск chat/cn/не-market", () => {
  const pages = parseLlmsTxt(LLMS_SAMPLE);
  assert.equal(pages.length, 4);
  const byUrl = Object.fromEntries(pages.map((p) => [p.url, p]));
  assert.equal(byUrl["https://docs.kie.ai/market/google/nano-banana.md"].category, "image");
  assert.equal(byUrl["https://docs.kie.ai/market/kling/v3.md"].category, "video");
  assert.equal(
    byUrl["https://docs.kie.ai/market/elevenlabs/text-to-dialogue-v3.md"].category,
    "audio"
  );
  assert.equal(byUrl["https://docs.kie.ai/market/seedream/5-pro-text-to-image.md"].description,
    "High-quality photorealistic image generation");
  // Chat Models, /cn/, не-market страницы — пропущены
  assert.ok(!pages.some((p) => p.url.includes("/cn/")));
  assert.ok(!pages.some((p) => p.url.includes("chat")));
  assert.ok(!pages.some((p) => p.url.includes("quickstart")));
});

test("extractModelIds: JSON-пример", () => {
  const md = '```json\n{\n  "model": "google/nano-banana",\n  "input": {"prompt": "x"}\n}\n```';
  assert.deepEqual(extractModelIds(md), ["google/nano-banana"]);
});

test("extractModelIds: YAML OpenAPI (enum/default/example)", () => {
  const md = [
    "properties:",
    "  model:",
    "    type: string",
    "    enum:",
    "      - kling-2.6/text-to-video",
    "    default: kling-2.6/text-to-video",
    "example:",
    '  model: kling-2.6/text-to-video',
    "  duration: \"5\"",
  ].join("\n");
  assert.deepEqual(extractModelIds(md), ["kling-2.6/text-to-video"]);
});

test("extractModelIds: фильтрация мусора", () => {
  const md = '{"model": "ab", "model2": "x"}\nmodel: \nmodel: 16:9\nmodel: no';
  assert.deepEqual(extractModelIds(md), []);
});

test("extractModelIds: основной id — самый частый", () => {
  const md = '"model": "a/bcd"\n"model": "a/bcd"\n"model": "x/yzw"';
  assert.deepEqual(extractModelIds(md)[0], "a/bcd");
});

test("mergeRegistries: seed приоритетен, динамика добавляется, stale помечается", () => {
  const live = [
    // совпадает с seed — метаданные из seed
    { id: "google/nano-banana", category: "image", description: "live desc", docUrl: "u1" },
    // новая динамическая модель
    { id: "kling-3.0/video", category: "video", description: "Kling 3", docUrl: "u2" },
  ];
  const merged = mergeRegistries(live, SEED_MODELS);

  const nano = merged.get("google/nano-banana");
  assert.equal(nano.stale, false);
  assert.deepEqual(nano.required, ["prompt"]); // метаданные seed, не dynamic-default
  assert.equal(nano.api, "jobs");

  const kling3 = merged.get("kling-3.0/video");
  assert.equal(kling3.dynamic, true);
  assert.equal(kling3.api, "jobs");
  assert.equal(kling3.prompt_field, "prompt");
  assert.deepEqual(kling3.required, []);
  assert.equal(kling3.description, "Kling 3");

  // seed-модель вне живого каталога — stale, но не удалена
  const imagen = merged.get("google/imagen4");
  assert.equal(imagen.stale, true);
  assert.equal(imagen.api, "jobs");

  // модели выделенных API живут вне market-каталога — они не stale
  const suno = merged.get("suno");
  assert.equal(suno.stale, false);
  assert.equal(suno.api, "suno");
  assert.ok(suno.docUrl);

  assert.equal(merged.size, live.length + Object.keys(SEED_MODELS).length - 1);
});
