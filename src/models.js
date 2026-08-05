/**
 * Seed-реестр моделей KIE API — встроенный fallback и источник метаданных
 * (required/prompt_field/image_field/api) для известных моделей.
 *
 * Живой каталог подтягивается из https://docs.kie.ai/llms.txt (src/registry.js);
 * seed всегда имеет приоритет метаданных при совпадении id.
 *
 * Поля записи:
 * - category: image | video | audio
 * - api: jobs | veo | runway | gpt4o | flux | suno — тип API (эндпоинты create/status)
 * - prompt_field: поле input, куда кладётся --prompt (null — модель не принимает промпт)
 * - image_field: поле input, куда кладутся URL изображений из --image (null — не принимает)
 * - image_list: true, если image_field — массив URL
 * - required: обязательные поля input (проверяются до запроса)
 * - defaults: значения, которые API требует обязательно, но у которых в схеме
 *   есть значение по умолчанию — подставляются, если пользователь не задал
 * - description: краткое описание и важные опциональные поля
 *
 * Метаданные сверены со схемами моделей на docs.kie.ai (velsvisual schema МОДЕЛЬ).
 */

export const CATEGORIES = ["image", "video", "audio"];
export const APIS = ["jobs", "veo", "runway", "gpt4o", "flux", "suno"];

/** Страницы документации выделенных API (вне market-каталога llms.txt). */
export const DEDICATED_DOC_URLS = {
  veo: "https://docs.kie.ai/veo3-api/generate-veo-3-video.md",
  suno: "https://docs.kie.ai/suno-api/generate-music.md",
  flux: "https://docs.kie.ai/flux-kontext-api/generate-or-edit-image.md",
  gpt4o: "https://docs.kie.ai/4o-image-api/generate-4-o-image.md",
  runway: "https://docs.kie.ai/runway-api/generate-ai-video.md",
};

function m(category, api, {
  prompt_field = "prompt",
  image_field = null,
  image_list = false,
  required = [],
  defaults = {},
  description = "",
} = {}) {
  const entry = {
    category, api, prompt_field, image_field, image_list, required, defaults, description,
  };
  // Модели выделенных API живут вне market-каталога: они не «протухшие»,
  // а просто не попадают в llms.txt — помечаем и даём ссылку на схему.
  if (api !== "jobs") {
    entry.dedicated = true;
    entry.docUrl = DEDICATED_DOC_URLS[api] || null;
  }
  return entry;
}

export const SEED_MODELS = {
  // ---------------------------------------------------------------- image
  "google/nano-banana": m("image", "jobs", {
    required: ["prompt"],
    description: "Nano Banana (Gemini 2.5 Flash Image) — быстрая и дешёвая text-to-image от Google.",
  }),
  "google/nano-banana-edit": m("image", "jobs", {
    image_field: "image_urls", image_list: true,
    required: ["prompt", "image_urls"],
    description: "Редактирование изображений по промпту (Nano Banana Edit).",
  }),
  "google/imagen4": m("image", "jobs", {
    required: ["prompt"],
    description: "Google Imagen 4 — качественная text-to-image.",
  }),
  "google/imagen4-fast": m("image", "jobs", {
    required: ["prompt"],
    description: "Google Imagen 4 Fast — быстрый вариант Imagen 4.",
  }),
  "google/imagen4-ultra": m("image", "jobs", {
    required: ["prompt"],
    description: "Google Imagen 4 Ultra — максимальное качество Imagen 4.",
  }),
  "bytedance/seedream-v4-text-to-image": m("image", "jobs", {
    required: ["prompt"],
    description: "Seedream 4.0 text-to-image. Опции: image_size, image_resolution (1K|2K|4K), max_images.",
  }),
  "bytedance/seedream-v4-edit": m("image", "jobs", {
    image_field: "image_urls", image_list: true,
    required: ["prompt", "image_urls"],
    description: "Seedream 4.0 edit — редактирование по референсам. Опции: image_size, image_resolution, max_images.",
  }),
  "gpt-image/1.5-text-to-image": m("image", "jobs", {
    required: ["prompt", "aspect_ratio", "quality"],
    defaults: { aspect_ratio: "1:1", quality: "medium" },
    description: "GPT Image 1.5 text-to-image. Обязательны: aspect_ratio (1:1|2:3|3:2), quality (medium|high).",
  }),
  "gpt-image/1.5-image-to-image": m("image", "jobs", {
    image_field: "input_urls", image_list: true,
    required: ["prompt", "aspect_ratio", "quality", "input_urls"],
    defaults: { aspect_ratio: "3:2", quality: "medium" },
    description: "GPT Image 1.5 image-to-image. Референсы — input_urls. "
      + "Обязательны: aspect_ratio (1:1|2:3|3:2), quality (medium|high).",
  }),
  "qwen/text-to-image": m("image", "jobs", {
    required: ["prompt"],
    description: "Qwen text-to-image — хорошо рендерит текст на изображении.",
  }),
  "qwen/image-edit": m("image", "jobs", {
    image_field: "image_url",
    required: ["prompt", "image_url"],
    description: "Qwen image edit — редактирование изображения по промпту.",
  }),
  "flux-2/pro-text-to-image": m("image", "jobs", {
    required: ["prompt", "aspect_ratio", "resolution"],
    defaults: { aspect_ratio: "1:1", resolution: "1K" },
    description: "FLUX.2 Pro text-to-image — высокое качество. "
      + "Обязательны: aspect_ratio (1:1|4:3|3:4|16:9|9:16|3:2), resolution (1K|2K).",
  }),
  "flux-2/flex-image-to-image": m("image", "jobs", {
    image_field: "input_urls", image_list: true,
    required: ["prompt", "input_urls", "aspect_ratio", "resolution"],
    defaults: { aspect_ratio: "1:1", resolution: "1K" },
    description: "FLUX.2 Flex image-to-image — генерация по референсам (input_urls). "
      + "Обязательны: aspect_ratio, resolution (1K|2K).",
  }),
  "grok-imagine/text-to-image": m("image", "jobs", {
    required: ["prompt"],
    description: "Grok Imagine text-to-image.",
  }),
  "z-image": m("image", "jobs", {
    required: ["prompt", "aspect_ratio"],
    defaults: { aspect_ratio: "1:1" },
    description: "Z-Image — лёгкая и быстрая text-to-image. aspect_ratio: 1:1|4:3|3:4|16:9|9:16.",
  }),
  "topaz/image-upscale": m("image", "jobs", {
    prompt_field: null, image_field: "image_url",
    required: ["image_url", "upscale_factor"],
    defaults: { upscale_factor: "2" },
    description: "Topaz Image Upscale — апскейл изображения. Промпт не нужен. upscale_factor: 1|2|4.",
  }),
  "recraft/remove-background": m("image", "jobs", {
    prompt_field: null, image_field: "image",
    required: ["image"],
    description: "Recraft Remove Background — удаление фона. Промпт не нужен; поле картинки — image.",
  }),
  "flux-kontext-pro": m("image", "flux", {
    image_field: "inputImage",
    required: ["prompt"],
    description: "FLUX Kontext Pro — генерация/редактирование. Опции: inputImage, aspectRatio, outputFormat (jpeg|png), enableTranslation.",
  }),
  "flux-kontext-max": m("image", "flux", {
    image_field: "inputImage",
    required: ["prompt"],
    description: "FLUX Kontext Max — топовая версия Kontext. Опции: inputImage, aspectRatio, outputFormat (jpeg|png), enableTranslation.",
  }),
  "gpt4o-image": m("image", "gpt4o", {
    image_field: "filesUrl", image_list: true,
    required: ["size"],
    description: "GPT-4o Image. Обязателен size (1:1|3:2|2:3); нужен --prompt и/или --image (filesUrl, до 5 URL).",
  }),
  // ---------------------------------------------------------------- video
  "veo3": m("video", "veo", {
    image_field: "imageUrls", image_list: true,
    required: ["prompt"],
    description: "Google Veo 3 — качественное видео со звуком. Опции: aspect_ratio (16:9|9:16|Auto), resolution (720p|1080p|4k), generationType, enableTranslation.",
  }),
  "veo3_fast": m("video", "veo", {
    image_field: "imageUrls", image_list: true,
    required: ["prompt"],
    description: "Google Veo 3 Fast — быстрый и дешёвый вариант Veo 3.",
  }),
  "veo3_lite": m("video", "veo", {
    image_field: "imageUrls", image_list: true,
    required: ["prompt"],
    description: "Google Veo 3 Lite — облегчённый вариант Veo 3.",
  }),
  "runway-gen3": m("video", "runway", {
    image_field: "imageUrl",
    required: ["prompt", "duration", "quality"],
    defaults: { duration: 5, quality: "720p" },
    description: "Runway Gen-3 — text/image-to-video. Обязательны duration (5|10) и quality (720p|1080p); "
      + "imageUrl опционален, есть aspectRatio (16:9|4:3|1:1|3:4|9:16).",
  }),
  "kling-2.6/text-to-video": m("video", "jobs", {
    required: ["prompt", "sound", "aspect_ratio", "duration"],
    description: 'Kling 2.6 text-to-video. Обязательны: sound (bool), aspect_ratio, duration ("5"|"10").',
  }),
  "kling-2.6/image-to-video": m("video", "jobs", {
    image_field: "image_urls", image_list: true,
    required: ["prompt", "image_urls", "sound", "duration"],
    description: 'Kling 2.6 image-to-video. image_urls — массив (макс. 1). Обязательны: sound (bool), duration ("5"|"10").',
  }),
  "kling/v2-5-turbo-text-to-video-pro": m("video", "jobs", {
    required: ["prompt"],
    description: "Kling 2.5 Turbo Pro text-to-video. Опции: duration (5|10), aspect_ratio (16:9|9:16|1:1), cfg_scale.",
  }),
  "kling/v2-5-turbo-image-to-video-pro": m("video", "jobs", {
    image_field: "image_url",
    required: ["prompt", "image_url"],
    description: "Kling 2.5 Turbo Pro image-to-video. Опции: tail_image_url (последний кадр), duration (5|10), cfg_scale.",
  }),
  "hailuo/2-3-image-to-video-pro": m("video", "jobs", {
    image_field: "image_url",
    required: ["prompt", "image_url"],
    description: 'Hailuo 2.3 Pro image-to-video. Опции: duration ("6"|"10"), resolution (768P|1080P).',
  }),
  "hailuo/02-text-to-video-pro": m("video", "jobs", {
    required: ["prompt"],
    description: "Hailuo 02 Pro text-to-video.",
  }),
  "hailuo/02-image-to-video-pro": m("video", "jobs", {
    image_field: "image_url",
    required: ["prompt", "image_url"],
    description: "Hailuo 02 Pro image-to-video.",
  }),
  "bytedance/v1-pro-text-to-video": m("video", "jobs", {
    required: ["prompt"],
    description: "ByteDance Seedance v1 Pro text-to-video.",
  }),
  "wan/2-6-image-to-video": m("video", "jobs", {
    image_field: "image_urls", image_list: true,
    required: ["prompt", "image_urls"],
    description: "Wan 2.6 image-to-video (image_urls — массив). Опции: duration (5|10|15), resolution (720p|1080p), multi_shots.",
  }),
  "grok-imagine/text-to-video": m("video", "jobs", {
    required: ["prompt"],
    description: "Grok Imagine text-to-video.",
  }),
  // ---------------------------------------------------------------- audio
  "suno": m("audio", "suno", {
    required: ["prompt", "model", "customMode", "instrumental"],
    defaults: { model: "V5", customMode: false, instrumental: false },
    description: "Suno — генерация музыки. model: V3_5|V4|V4_5|V4_5PLUS|V4_5ALL|V5|V5_5 (по умолчанию V5). "
      + "customMode=true требует style и title; опции: instrumental, negativeTags, vocalGender (m|f), "
      + "styleWeight, weirdnessConstraint, audioWeight, duration (только V5_5).",
  }),
  "elevenlabs/text-to-speech-turbo-2-5": m("audio", "jobs", {
    prompt_field: "text",
    required: ["text"],
    description: "ElevenLabs TTS Turbo v2.5 — быстрая озвучка. text ≤ 5000 символов. "
      + "Опции: voice, stability, similarity_boost, style, speed (0.7–1.2).",
  }),
  "elevenlabs/text-to-speech-multilingual-v2": m("audio", "jobs", {
    prompt_field: "text",
    required: ["text", "voice"],
    defaults: { voice: "EkK5I93UQWFDigLMpZcX" },
    description: "ElevenLabs TTS Multilingual v2 — качественная мультиязычная озвучка. text ≤ 5000 символов. "
      + "voice обязателен (id голоса; список — в schema), опции: stability, similarity_boost, style, speed.",
  }),
};

/** Метаданные по умолчанию для динамических моделей из живого каталога (Market API). */
export function dynamicModel(category, description = "") {
  return {
    category,
    api: "jobs",
    prompt_field: "prompt",
    image_field: null,
    image_list: false,
    required: [],
    description,
    dynamic: true,
  };
}
