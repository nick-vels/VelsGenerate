import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  UsageError,
  buildInput,
  parseArgs,
  parseSetValue,
  resolveLocalFiles,
  resolveModel,
  validateInput,
} from "../src/cli.js";
import { SEED_MODELS } from "../src/models.js";

const registry = new Map(Object.entries(SEED_MODELS));

// ------------------------------------------------------------------ parseArgs
test("parseArgs: bool/value/multi/позиционные/--flag=value", () => {
  const { flags, positionals } = parseArgs(
    ["model/x", "--prompt", "hi", "--image", "a.png", "--image=b.png", "--wait", "--set", "k=1"],
    { bool: ["--wait"], value: ["--prompt"], multi: ["--image", "--set"] }
  );
  assert.equal(positionals[0], "model/x");
  assert.equal(flags["--prompt"], "hi");
  assert.deepEqual(flags["--image"], ["a.png", "b.png"]);
  assert.equal(flags["--wait"], true);
  assert.deepEqual(flags["--set"], ["k=1"]);
});

test("parseArgs: неизвестный флаг и alias", () => {
  assert.throws(() => parseArgs(["--nope"], {}), UsageError);
  const { flags } = parseArgs(["-o", "out.png"], { value: ["--output"], alias: { "-o": "--output" } });
  assert.equal(flags["--output"], "out.png");
});

// ------------------------------------------------------------------ --set
test("parseSetValue: JSON или строка", () => {
  assert.equal(parseSetValue("true"), true);
  assert.equal(parseSetValue("false"), false);
  assert.equal(parseSetValue("5"), 5);
  assert.equal(parseSetValue("1.5"), 1.5);
  assert.deepEqual(parseSetValue('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseSetValue('{"k":1}'), { k: 1 });
  assert.equal(parseSetValue('"quoted"'), "quoted");
  assert.equal(parseSetValue("16:9"), "16:9");
  assert.equal(parseSetValue("V4_5"), "V4_5");
  assert.equal(parseSetValue(""), "");
});

// ------------------------------------------------------------------ buildInput
test("buildInput: промпт в prompt_field модели", () => {
  const model = resolveModel("elevenlabs/text-to-speech-turbo-2-5", null, registry);
  assert.deepEqual(buildInput(model, { prompt: "привет" }), { text: "привет" });
});

test("buildInput: image list vs scalar, защита от лишних", () => {
  const kling = resolveModel("kling-2.6/image-to-video", null, registry);
  const data = buildInput(kling, { prompt: "go", images: ["https://x/1.png"] });
  assert.deepEqual(data.image_urls, ["https://x/1.png"]);

  const flux = resolveModel("flux-kontext-pro", null, registry);
  assert.equal(buildInput(flux, { prompt: "go", images: ["https://x/1.png"] }).inputImage,
    "https://x/1.png");
  assert.throws(
    () => buildInput(flux, { prompt: "go", images: ["https://x/1.png", "https://x/2.png"] }),
    UsageError
  );

  const nano = resolveModel("google/nano-banana", null, registry);
  assert.throws(() => buildInput(nano, { prompt: "go", images: ["https://x/1.png"] }), UsageError);
});

test("buildInput: приоритет prompt < --set < --json-input", () => {
  const model = resolveModel("google/nano-banana", null, registry);
  const data = buildInput(model, {
    prompt: "a",
    setPairs: ["prompt=b", "n=3"],
    jsonInputStr: '{"prompt": "c"}',
  });
  assert.deepEqual(data, { prompt: "c", n: 3 });
});

test("buildInput: suno — model по умолчанию V5, --set переопределяет", () => {
  const model = resolveModel("suno", null, registry);
  assert.equal(buildInput(model, { prompt: "song" }).model, "V5");
  assert.equal(buildInput(model, { prompt: "song", setPairs: ["model=V4_5"] }).model, "V4_5");
});

test("resolveModel: неизвестная модель требует --api", () => {
  assert.throws(() => resolveModel("some/future-model", null, registry), UsageError);
  const generic = resolveModel("some/future-model", "jobs", registry);
  assert.equal(generic.api, "jobs");
});

// ------------------------------------------------------------------ validateInput
test("validateInput: required image-поле до сети (topaz)", () => {
  const model = resolveModel("topaz/image-upscale", null, registry);
  assert.throws(
    () => validateInput(model, buildInput(model, { prompt: "x" })),
    /image_url/
  );
  validateInput(model, buildInput(model, { images: ["./local.png"] }));
});

test("validateInput: обязательные поля kling через --set", () => {
  const model = resolveModel("kling-2.6/text-to-video", null, registry);
  assert.throws(
    () => validateInput(model, buildInput(model, { prompt: "x" })),
    (err) => {
      assert.match(err.message, /sound/);
      assert.match(err.message, /aspect_ratio/);
      assert.match(err.message, /duration/);
      return true;
    }
  );
  const data = buildInput(model, {
    prompt: "x",
    setPairs: ["sound=true", "aspect_ratio=16:9", "duration=5"],
  });
  validateInput(model, data);
  assert.equal(data.sound, true);
  assert.equal(data.duration, 5);
});

test("validateInput: gpt4o — size обязателен, нужен prompt или filesUrl", () => {
  const model = resolveModel("gpt4o-image", null, registry);
  assert.throws(() => validateInput(model, buildInput(model, { prompt: "x" })), /size/);
  assert.throws(
    () => validateInput(model, buildInput(model, { setPairs: ["size=1:1"] })),
    /prompt/
  );
  validateInput(model, buildInput(model, { prompt: "x", setPairs: ["size=1:1"] }));
});

test("validateInput: suno customMode требует style и title", () => {
  const model = resolveModel("suno", null, registry);
  assert.throws(
    () => validateInput(model, buildInput(model, { prompt: "song", setPairs: ["customMode=true"] })),
    /style/
  );
  validateInput(
    model,
    buildInput(model, {
      prompt: "song",
      setPairs: ["customMode=true", "style=rock", "title=Song"],
    })
  );
});

test("validateInput: динамическая модель — мягкая валидация", () => {
  const dynamic = {
    category: "video", api: "jobs", prompt_field: "prompt",
    image_field: null, image_list: false, required: [], dynamic: true,
  };
  validateInput(dynamic, buildInput(dynamic, { prompt: "что угодно" }));
});

// ------------------------------------------------------------------ defaults
test("buildInput: обязательные поля с дефолтом подставляются, --set главнее", () => {
  const model = resolveModel("flux-2/pro-text-to-image", null, registry);
  const data = buildInput(model, { prompt: "кот" });
  assert.equal(data.aspect_ratio, "1:1");
  assert.equal(data.resolution, "1K");

  const custom = buildInput(model, { prompt: "кот", setPairs: ["aspect_ratio=16:9"] });
  assert.equal(custom.aspect_ratio, "16:9");
  validateInput(model, data);
});

test("buildInput: подсказка про schema, если модель не описывает поле картинки", () => {
  const dynamic = {
    id: "vendor/new-model", category: "video", api: "jobs", prompt_field: "prompt",
    image_field: null, image_list: false, required: [], dynamic: true,
  };
  assert.throws(
    () => buildInput(dynamic, { prompt: "x", images: ["./a.png"] }),
    /velsgenerate schema vendor\/new-model/
  );
});

// ------------------------------------------------------------------ загрузка файлов
test("resolveLocalFiles: локальные файлы грузятся из любого поля, URL не трогаются", async () => {
  const file = fileURLToPath(import.meta.url); // существующий файл
  const uploads = [];
  const client = {
    upload: async (path) => {
      uploads.push(path);
      return `https://uploaded/${uploads.length}.png`;
    },
  };
  const model = { prompt_field: "prompt", image_field: null };
  const data = {
    prompt: "текст промпта",
    first_frame_url: file,
    reference_image_urls: [file, "https://cdn/x.png", "asset://asset-1"],
    resolution: "480p",
    duration: 6,
  };
  await resolveLocalFiles(client, model, data, () => {});

  assert.match(data.first_frame_url, /^https:\/\/uploaded\//);
  // один и тот же файл загружается один раз
  assert.equal(uploads.length, 1);
  assert.equal(data.reference_image_urls[0], data.first_frame_url);
  assert.equal(data.reference_image_urls[1], "https://cdn/x.png");
  assert.equal(data.reference_image_urls[2], "asset://asset-1");
  assert.equal(data.resolution, "480p");
  assert.equal(data.duration, 6);
  assert.equal(data.prompt, "текст промпта");
});

test("resolveLocalFiles: для --image путь обязан быть файлом или URL", async () => {
  const client = { upload: async () => "https://uploaded/1.png" };
  const model = { prompt_field: "prompt", image_field: "image_url" };
  await assert.rejects(
    () => resolveLocalFiles(client, model, { image_url: "./нет-такого-файла.png" }, () => {}),
    UsageError
  );
});
