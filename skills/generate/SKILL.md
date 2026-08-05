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
velsgenerate schema МОДЕЛЬ --json          # реальные поля input этой модели
```

В выводе `models --json` у каждой модели есть `required`, `api`, `docUrl` и пометка
`[stale]` (в живом каталоге модели больше нет — ищи свежий аналог через `--search`).

**CLI сам знает поля новых моделей.** Перед запуском `run` подтягивает схему модели
из её документации (кэш 24ч) и по ней определяет, куда класть промпт и картинку,
что обязательно и какие обязательные поля имеют значения по умолчанию. Поэтому модель,
вышедшая на kie.ai вчера, работает без обновления CLI — не нужно ни угадывать поля,
ни ждать релиза. Отключить: `--no-schema`, обновить принудительно: `--refresh-schema`.

## Установка и онбординг — одной командой

```bash
npx -y velsgenerate setup     # скачает CLI и запустит мастер: API-ключ (с проверкой баланса) + этот скилл
```

Если пакет уже установлен глобально — просто `velsgenerate setup`. Для постоянной
установки после npx: `npm i -g velsgenerate`. Обновление: `npm i -g velsgenerate@latest`
(CLI) и `npx -y skills update generate` (этот скилл); каталог моделей и схемы
обновляются сами. Ключ также можно задать вручную:
`export KIE_API_KEY=ваш_ключ` или `velsgenerate config --set-key ваш_ключ`.
Если ключа нет — CLI скажет об этом понятной ошибкой; попроси ключ у пользователя,
не выдумывай его. Проверка: `velsgenerate credits`.

## Команды

```bash
velsgenerate setup [--yes] [--local] [--repo РЕПО]     # мастер настройки (alias: init)
velsgenerate credits                                   # баланс
velsgenerate models [--refresh] [--category image|video|audio] [--search ТЕКСТ]
velsgenerate schema МОДЕЛЬ [--raw]                     # поля input модели из её документации
velsgenerate upload ФАЙЛ                               # локальный файл → fileUrl
velsgenerate run МОДЕЛЬ [--prompt ТЕКСТ] [--image ФАЙЛ_ИЛИ_URL ...] \
    [--set ключ=значение ...] [--json-input 'JSON'] [--dry-run] \
    [--wait] [--timeout СЕК] [--interval СЕК] [--download КАТАЛОГ]
velsgenerate status TASK_ID [--api jobs|veo|runway|gpt4o|flux|suno]
velsgenerate wait TASK_ID [--timeout 600] [--interval 5] [--api ...]
velsgenerate download URL [-o ПУТЬ]
velsgenerate config --set-key KEY
```

- `--set k=v` — значение парсится как JSON (`true`, `5`, `["a"]`), иначе строка.
- `--json-input` — сырой JSON-объект поверх собранного input (любые поля любой модели).
- `--image` — локальный путь (CLI загрузит его сам) или готовый URL.
- **Локальный файл можно передать в любое поле**: `--set first_frame_url=./sky.jpg`,
  `--set reference_image_urls='["./a.png"]'` — существующие пути загружаются автоматически.
- `--dry-run` — показать итоговый input и не отправлять запрос (не тратит кредиты).
- Кэши: реестр `~/.velsgenerate/models-cache.json`, схемы `~/.velsgenerate/schema-cache.json`,
  оба с TTL 24ч.

## Правила (обязательно)

1. **Сначала модель, потом запуск.** Не используй id моделей из памяти или примеров
   ниже без проверки — сначала `velsgenerate models --search <задача> --json`.
   Примеры в этом файле — иллюстрации синтаксиса, а не рекомендация конкретных id.
2. **Незнакомая модель — сначала `schema`.** `velsgenerate schema МОДЕЛЬ --json` даёт
   точные имена полей, enum-значения и дефолты. Это дешевле, чем ловить 422.
3. **Всегда добавляй `--json`** — вывод машиночитаемый: `taskId`, `state`, `urls`, `tracks`.
4. **Скачивай результаты сразу** — URL живут ~24 часа. Используй `--wait --download КАТАЛОГ`
   или `velsgenerate download URL` сразу после получения `urls`.
5. **Асинхронный паттерн run → wait**: либо сразу `run --wait --timeout 600`,
   либо `run` (получил `taskId`) → `wait <taskId>`. Видео и музыка могут генерироваться
   минуты — для них ставь `--timeout 900` или больше.
6. **Не трать кредиты на пробы.** Проверять сборку запроса — через `--dry-run`;
   каждый реальный `run` списывает кредиты, даже если результат не понравился.
7. Не передавай секреты и ключ в аргументах команд (кроме `config --set-key`).
8. При ошибке API смотри на `code`: 401 — ключ, 402 — кредиты кончились, 422 — невалидный
   input (сверься с `velsgenerate schema МОДЕЛЬ`), 429 — rate limit (повтори позже),
   451 — API не скачал входное изображение (перезалей через `upload`), 455 — maintenance,
   500/501 — генерация не удалась (см. текст ошибки, часто помогает смена параметров).

## Типичные грабли

- **`[500] output audio may be related to copyright restrictions`** у видеомоделей
  (Seedance и другие с `generate_audio`): модель не смогла легально сгенерировать
  звуковую дорожку. Перезапусти с `--set generate_audio=false`.
- **Квадратная картинка в 16:9** — модели по умолчанию ставят `aspect_ratio: 16:9`
  и обрежут кадр. Для анимации готового изображения задавай соотношение исходника
  (`--set aspect_ratio=1:1`) или `adaptive`, если модель его поддерживает.
- **Поле картинки называется по-разному**: `image_url`, `image_urls`, `input_urls`,
  `first_frame_url`, `image`. `--image` подставит правильное само; при ручном `--set`
  сверься со `schema`.
- **Дороже ≠ лучше для черновика**: сначала прогони дешёвую/быструю версию модели
  (`-fast`, `-mini`, `480p`, короткая длительность), финальный рендер — после утверждения.
- **`[451]`** — API не смог скачать твой URL. Перезалей файл: `velsgenerate upload ФАЙЛ`.

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

### Оживить готовую картинку (image-to-video)

```bash
velsgenerate schema bytedance/seedance-2-mini --json   # узнать поля и дефолты
velsgenerate run bytedance/seedance-2-mini \
  --prompt "облака медленно плывут, свет меняется, камера статична" \
  --image ./sky.jpg \
  --set duration=6 --set resolution=480p --set aspect_ratio=1:1 \
  --set generate_audio=false \
  --wait --timeout 900 --download ./out --json
```

`--image` кладётся в то поле, которое реально есть у модели (`first_frame_url`,
`image_urls`, …). Явный двухшаговый вариант: `velsgenerate upload ./sky.jpg` →
подставить URL в `--set ПОЛЕ=...`.

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

Список доступных голосов — в `velsgenerate schema elevenlabs/text-to-speech-turbo-2-5`
(поле `voice`, enum с id голосов).

### Апскейл

```bash
velsgenerate run topaz/image-upscale --image ./photo.png \
  --set upscale_factor=2 --wait --download ./out --json
```

### Проверка зависшей задачи

```bash
velsgenerate status <taskId> --json        # API определится автоматически
velsgenerate wait <taskId> --timeout 600 --json
```

### Совсем новая модель (ещё не в каталоге)

```bash
velsgenerate run some/future-model --api jobs --json-input '{"prompt": "..."}' --json
```

Если модель уже в каталоге, но появилась после последнего обновления кэша, `run`
обновит реестр сам — `--api` указывать не нужно.
