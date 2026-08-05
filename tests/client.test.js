import test from "node:test";
import assert from "node:assert/strict";

import {
  APIS,
  SEED_MODELS,
  CATEGORIES,
} from "../src/models.js";
import {
  CASCADE_ORDER,
  CREATE_ENDPOINTS,
  STATUS_ENDPOINTS,
  extractFileUrl,
  normalizeStatus,
} from "../src/client.js";

// ------------------------------------------------------------------ реестр
test("seed-реестр: структура всех записей", () => {
  assert.ok(Object.keys(SEED_MODELS).length >= 30);
  for (const [id, m] of Object.entries(SEED_MODELS)) {
    assert.ok(CATEGORIES.includes(m.category), id);
    assert.ok(APIS.includes(m.api), id);
    assert.ok("prompt_field" in m && "image_field" in m, id);
    assert.ok(Array.isArray(m.required), id);
    assert.ok(m.description, id);
  }
});

test("seed покрывает все типы API", () => {
  assert.deepEqual(new Set(Object.values(SEED_MODELS).map((m) => m.api)), new Set(APIS));
});

// ------------------------------------------------------------------ эндпоинты
test("маршрутизация эндпоинтов", () => {
  assert.equal(CREATE_ENDPOINTS.jobs, "/api/v1/jobs/createTask");
  assert.equal(CREATE_ENDPOINTS.veo, "/api/v1/veo/generate");
  assert.equal(CREATE_ENDPOINTS.runway, "/api/v1/runway/generate");
  assert.equal(CREATE_ENDPOINTS.gpt4o, "/api/v1/gpt4o-image/generate");
  assert.equal(CREATE_ENDPOINTS.flux, "/api/v1/flux/kontext/generate");
  assert.equal(CREATE_ENDPOINTS.suno, "/api/v1/generate");
  assert.equal(STATUS_ENDPOINTS.jobs, "/api/v1/jobs/recordInfo");
  assert.equal(STATUS_ENDPOINTS.runway, "/api/v1/runway/record-detail");
  assert.equal(STATUS_ENDPOINTS.suno, "/api/v1/generate/record-info");
  assert.deepEqual(new Set(Object.keys(CREATE_ENDPOINTS)), new Set(APIS));
  assert.deepEqual(new Set(Object.keys(STATUS_ENDPOINTS)), new Set(APIS));
});

// ------------------------------------------------------------------ upload
test("extractFileUrl: реальный ответ upload API (downloadUrl)", () => {
  const data = {
    success: true,
    fileName: "sky.jpeg",
    filePath: "kieai/1/images/sky.jpeg",
    downloadUrl: "https://tempfile.redpandaai.co/kieai/1/images/sky.jpeg",
    fileSize: 2602701,
  };
  assert.equal(extractFileUrl(data), "https://tempfile.redpandaai.co/kieai/1/images/sky.jpeg");
});

test("extractFileUrl: старые схемы ответа и вложенность", () => {
  assert.equal(extractFileUrl({ fileUrl: "https://x/1.png" }), "https://x/1.png");
  assert.equal(extractFileUrl({ url: "https://x/2.png" }), "https://x/2.png");
  assert.equal(extractFileUrl({ data: { downloadUrl: "https://x/3.png" } }), "https://x/3.png");
  assert.equal(extractFileUrl({ result: { file: { url: "https://x/4.png" } } }), "https://x/4.png");
});

test("extractFileUrl: нет URL — null (не путь и не мусор)", () => {
  assert.equal(extractFileUrl({ filePath: "kieai/1/images/sky.jpeg" }), null);
  assert.equal(extractFileUrl({ success: true }), null);
  assert.equal(extractFileUrl(null), null);
  assert.equal(extractFileUrl("строка"), null);
});

test("порядок каскада автоопределения API", () => {
  assert.deepEqual(CASCADE_ORDER, ["jobs", "veo", "suno", "gpt4o", "flux", "runway"]);
});

// ------------------------------------------------------------------ normalizeStatus
test("jobs: success — resultJson это JSON-строка", () => {
  const st = normalizeStatus("jobs", {
    state: "success",
    resultJson: '{"resultUrls": ["https://x/1.png"]}',
  });
  assert.equal(st.state, "success");
  assert.deepEqual(st.urls, ["https://x/1.png"]);
});

test("jobs: fail и pending-состояния", () => {
  const fail = normalizeStatus("jobs", { state: "fail", failCode: "501", failMsg: "boom" });
  assert.equal(fail.state, "fail");
  assert.match(fail.fail_msg, /boom/);
  assert.match(fail.fail_msg, /501/);
  for (const state of ["waiting", "queuing", "generating"]) {
    assert.equal(normalizeStatus("jobs", { state }).state, "pending");
  }
});

test("veo: successFlag 0/1/2/3", () => {
  assert.equal(normalizeStatus("veo", { successFlag: 0 }).state, "pending");
  const ok = normalizeStatus("veo", { successFlag: 1, response: { resultUrls: ["u"] } });
  assert.equal(ok.state, "success");
  assert.deepEqual(ok.urls, ["u"]);
  for (const flag of [2, 3]) {
    assert.equal(normalizeStatus("veo", { successFlag: flag }).state, "fail");
  }
});

test("flux: resultImageUrl", () => {
  const st = normalizeStatus("flux", { successFlag: 1, resultImageUrl: "https://x/i.png" });
  assert.equal(st.state, "success");
  assert.deepEqual(st.urls, ["https://x/i.png"]);
});

test("runway: videoInfo.videoUrl", () => {
  assert.equal(normalizeStatus("runway", { state: "queueing" }).state, "pending");
  const ok = normalizeStatus("runway", {
    state: "success",
    videoInfo: { videoUrl: "https://x/v.mp4" },
  });
  assert.equal(ok.state, "success");
  assert.deepEqual(ok.urls, ["https://x/v.mp4"]);
  assert.equal(normalizeStatus("runway", { state: "fail", failMsg: "x" }).state, "fail");
});

test("suno: SUCCESS — audioUrl/streamAudioUrl треков", () => {
  const st = normalizeStatus("suno", {
    status: "SUCCESS",
    response: {
      sunoData: [
        { audioUrl: "a1", streamAudioUrl: "s1", imageUrl: "i1", duration: 120 },
        { audioUrl: "a2", streamAudioUrl: "s2" },
      ],
    },
  });
  assert.equal(st.state, "success");
  assert.deepEqual(st.urls, ["a1", "a2"]);
  assert.equal(st.tracks[0].streamAudioUrl, "s1");
});

test("suno: pending и failed статусы", () => {
  for (const status of ["PENDING", "TEXT_SUCCESS", "FIRST_SUCCESS"]) {
    assert.equal(normalizeStatus("suno", { status }).state, "pending");
  }
  for (const status of ["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "SENSITIVE_WORD_ERROR"]) {
    assert.equal(normalizeStatus("suno", { status }).state, "fail");
  }
});

test("gpt4o: fallback на jobs-форму по полю state", () => {
  const st = normalizeStatus("gpt4o", {
    state: "success",
    resultJson: '{"resultUrls": ["https://x/4o.png"]}',
  });
  assert.equal(st.state, "success");
  assert.deepEqual(st.urls, ["https://x/4o.png"]);
});
