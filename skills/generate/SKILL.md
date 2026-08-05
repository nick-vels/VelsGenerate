---
name: generate
description: Генерация фото, видео и аудио через VelsGenerate CLI и KIE API (kie.ai). Используй, когда пользователь просит «сгенерируй картинку/изображение/фото/видео/музыку/песню/озвучку/голос/саунд-эффект», text-to-image, image-to-video, TTS или апскейл изображения.
---

# VelsGenerate — генерация медиа через KIE API

CLI на Node.js (ноль зависимостей, Node >= 18) обращается к KIE API (kie.ai) и умеет
генерировать изображения, видео и аудио сотней моделей.

**Каталога моделей в скилле нет нарочно** — модели на kie.ai выходят каждую неделю,
любой список в файле устаревает. Источник истины — живой реестр в самом CLI.
Перед каждой генерацией выбирай модель через него:

```bash
velsgenerate models --refresh --json       # обновить реестр из docs.kie.ai (делай раз в сессию)
velsgenerate models --category image --search nano --json   # поиск по id и описанию
```

В выводе `models --json` у каждой модели есть `required` (обязательные поля),
`api`, `docUrl` (страница на docs.kie.ai с полной схемой input) и пометки
`[stale]` (старый id — ищи свежий аналог через `--search`).

## Установка и онбординг — одной командой

```bash
npx -y velsgenerate setup     # скачает CLI и запустит мастер: API-ключ (с проверкой баланса) + этот скилл
```

Если пакет уже установлен глобально — просто `velsgenerate setup`. Для постоянной
установки после npx: `npm i -g velsgenerate`. Ключ также можно задать вручную:
`export KIE_API_KEY=ваш_ключ` или `velsgenerate config --set-key ваш_ключ`.
Если ключа нет — CLI скажет об этом понятной ошибкой; попроси ключ у пользователя,
не выдумывай его. Проверка: `velsgenerate credits`.

## Команды

```bash
velsgenerate setup [--yes] [--local] [--repo РЕПО]     # мастер настройки (alias: init)
velsgenerate credits                                   # баланс
velsgenerate models [--refresh] [--category image|video|audio] [--search ТЕКСТ]
velsgenerate upload ФАЙЛ                               # локальный файл → fileUrl
velsgenerate run МОДЕЛЬ [--prompt ТЕКСТ] [--image ФАЙЛ_ИЛИ_URL ...] \
    [--set ключ=значение ...] [--json-input 'JSON'] \
    [--wait] [--timeout СЕК] [--interval СЕК] [--download КАТАЛОГ]
velsgenerate status TASK_ID [--api jobs|veo|runway|gpt4o|flux|suno]
velsgenerate wait TASK_ID [--timeout 600] [--interval 5] [--api ...]
velsgenerate download URL [-o ПУТЬ]
velsgenerate config --set-key KEY
```

- `--set k=v` — значение парсится как JSON (`true`, `5`, `["a"]`), иначе строка.
- `--json-input` — сырой JSON-объект поверх собранного input (любые поля любой модели).
- `--image` — локальный путь (CLI сам загрузит через upload API) или готовый URL.
- Реестр моделей живой: кэш `~/.velsgenerate/models-cache.json` с TTL 24ч,
  `models --refresh` — принудительное обновление. Источник данных указан в выводе
  (`live`/`cache`/`seed`).

## Правила (обязательно)

1. **Сначала модель, потом запуск.** Не используй id моделей из памяти или примеров
   ниже без проверки — сначала `velsgenerate models --search <задача> --json`.
   Примеры в этом файле — иллюстрации синтаксиса, а не рекомендация конкретных id.
2. **Всегда добавляй `--json`** — вывод машиночитаемый: `taskId`, `state`, `urls`, `tracks`.
3. **Скачивай результаты сразу** — URL живут ~24 часа. Используй `--wait --download КАТАЛОГ`
   или `velsgenerate download URL` сразу после получения `urls`.
4. **Асинхронный паттерн run → wait**: либо сразу `run --wait --timeout 600`,
   либо `run` (получил `taskId`) → `wait <taskId>`. Видео и музыка могут генерироваться
   минуты — для них ставь `--timeout 900` или больше.
5. **Новая/незнакомая модель**: у динамических моделей api `jobs`, `--prompt` работает,
   остальные поля добирай через `--set`/`--json-input` по схеме из `docUrl`
   (вывод `models --json`) или со страницы модели на docs.kie.ai.
6. Не передавай секреты и ключ в аргументах команд (кроме `config --set-key`).
7. При ошибке API смотри на `code`: 401 — ключ, 402 — кредиты кончились, 422 — невалидный
   input (сверься с документацией модели), 429 — rate limit (повтори позже), 451 — API не скачал
   входное изображение (перезалей через `upload`), 455 — maintenance, 501 — генерация не удалась.

## Как выбрать модель под задачу

```bash
velsgenerate models --category image --search text-to-image --json   # картинка по тексту
velsgenerate models --category image --search edit --json            # редактирование картинки
velsgenerate models --category image --search upscale --json         # апскейл / удаление фона
velsgenerate models --category video --search image-to-video --json  # видео из картинки
velsgenerate models --category video --search text-to-video --json   # видео по тексту
velsgenerate models --category audio --json                          # музыка, TTS, эффекты
```

Выбирай самую свежую версию семейства (наибольший номер), если пользователь не просил
иное. Стабильные выделенные API, которые живут вне market-каталога и есть всегда:
`suno` (музыка), `veo3` / `veo3_fast` / `veo3_lite` (видео), `flux-kontext-pro` /
`flux-kontext-max` (редактирование изображений), `gpt4o-image`, `runway-gen3`.

## Типовые workflow (id моделей — примеры, проверяй через models --search)

### Text-to-image

```bash
velsgenerate run google/nano-banana \
  --prompt "рыжий кот в скафандре, кинематографичный свет" \
  --wait --download ./out --json
```

### Image-to-video (локальный файл)

```bash
# --image сам загрузит файл через upload API
velsgenerate run veo3_fast --prompt "кот машет лапой, камера статична" \
  --image ./cat.png --set aspect_ratio=16:9 \
  --wait --timeout 900 --download ./out --json
```

Явный двухшаговый вариант: `velsgenerate upload ./cat.png` → подставить `fileUrl`
в `--image` или `--set image_url=...`.

### Text-to-music (Suno)

```bash
# простой режим: только промпт
velsgenerate run suno --prompt "спокойный лоуфай для учёбы" \
  --wait --timeout 900 --download ./out --json

# custom mode: style и title обязательны
velsgenerate run suno --prompt "куплеты на русском про осенний город" \
  --set customMode=true --set style="indie rock, female vocal" --set title="Осень" \
  --set model=V5 --wait --timeout 900 --download ./out --json
```

В ответе у каждого трека есть `audioUrl` (скачивать его) и `streamAudioUrl`.

### TTS (озвучка)

```bash
velsgenerate run elevenlabs/text-to-speech-turbo-2-5 \
  --prompt "Текст, который нужно озвучить." \
  --set stability=0.5 --set speed=1.0 \
  --wait --download ./out --json
```

### Апскейл

```bash
velsgenerate run topaz/image-upscale --image ./photo.png \
  --wait --download ./out --json
```

### Проверка зависшей задачи

```bash
velsgenerate status <taskId> --json        # API определится автоматически
velsgenerate wait <taskId> --timeout 600 --json
```

### Модель вне реестра

```bash
velsgenerate run some/future-model --api jobs --json-input '{"prompt": "..."}' --json
```
