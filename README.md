```
__     _______ _     ____   __     _____ ____  _   _   _    _
\ \   / / ____| |   / ___|  \ \   / /_ _/ ___|| | | | / \  | |
 \ \ / /|  _| | |   \___ \   \ \ / / | |\___ \| | | |/ _ \ | |
  \ V / | |___| |___ ___) |   \ V /  | | ___) | |_| / ___ \| |___
   \_/  |_____|_____|____/     \_/  |___|____/ \___/_/   \_\_____|
```

# VelsVisual

[![npm](https://img.shields.io/npm/v/velsvisual.svg)](https://www.npmjs.com/package/velsvisual)
[![CI](https://github.com/nick-vels/VelsVisual/actions/workflows/ci.yml/badge.svg)](https://github.com/nick-vels/VelsVisual/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/velsvisual.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/velsvisual.svg)](LICENSE)

CLI на Node.js для генерации **фото, видео и аудио** через [KIE API](https://kie.ai) (docs.kie.ai).
Один инструмент поверх всех API платформы: универсальный Market API (jobs), Seedance,
GPT Image, Wan, Suno, ElevenLabs и десятки других моделей.
**Ноль runtime-зависимостей** — только Node.js >= 18.

## Установка и онбординг — одной командой

```bash
npx -y velsvisual setup
```

`npx` скачает CLI и сразу запустит мастер настройки (см. ниже). Для постоянной
установки: `npm i -g velsvisual`. Альтернативы — прямо из GitHub
(`npm i -g github:nick-vels/VelsVisual`) или из локальных исходников
(`npm install -g .` в корне репозитория). Если пакет уже установлен — мастер
доступен как `velsvisual setup` (alias: `init`).

Мастер проведёт по шагам:

1. **API-ключ** — предложит взять `KIE_API_KEY` из окружения или ввести вручную
   (ключ выдаётся на https://kie.ai/api-key), проверит его запросом баланса
   и сохранит в `~/.velsvisual/config.json` (chmod 600).
2. **Скилл для агента** — установит скилл `visual` командой
   `npx -y skills add nick-vels/VelsVisual` или скопирует его из пакета
   локально (`velsvisual setup --local`). Другой источник — флаг
   `velsvisual setup --repo владелец/репозиторий`.
3. Покажет сводку и пример первой генерации.

Неинтерактивный режим: `velsvisual setup --yes` (берёт ключ из env).
Без мастера: `export KIE_API_KEY=ваш_ключ` или `velsvisual config --set-key ваш_ключ`.

## Обновление

```bash
npm i -g velsvisual@latest     # обновить CLI (если установлен глобально)
npx -y skills update visual    # обновить скилл агента (alias: upgrade)
velsvisual --version           # проверить версию
```

- Через `npx -y velsvisual ...` версия всегда свежая — обновлять нечего.
- Из GitHub (свежий main до публикации релиза): `npm i -g github:nick-vels/VelsVisual`.
- Из локальных исходников: `git pull && npm install -g .` в корне репозитория.
- Скилл можно и переустановить поверх: `npx -y skills add nick-vels/VelsVisual`.
  Восстановить ровно те версии, что записаны в `skills-lock.json`:
  `npx -y skills experimental_install`.
- **Каталог моделей и схемы обновлять вручную не нужно** — они живые и не зависят
  от версии CLI (кэш 24ч). Принудительно: `velsvisual models --refresh`
  и `velsvisual run ... --refresh-schema`.

## Примеры

```bash
# Картинка (text-to-image) — создать задачу, дождаться, скачать в ./out
velsvisual run google/nano-banana --prompt "рыжий кот в скафандре, кинематографично" \
  --wait --download ./out

# Видео из картинки: локальный файл будет сначала загружен через upload API
velsvisual run veo3_fast --prompt "кот машет лапой" --image ./cat.png \
  --set aspect_ratio=16:9 --wait --timeout 900 --download ./out

# Музыка (Suno, custom mode)
velsvisual run suno --prompt "песня про осенний город" \
  --set customMode=true --set style="indie rock, female vocal" --set title="Осень" \
  --wait --download ./out

# Озвучка (ElevenLabs TTS)
velsvisual run elevenlabs/text-to-speech-turbo-2-5 \
  --prompt "Привет! Это тестовая озвучка." --wait --download ./out

# Апскейл изображения
velsvisual run topaz/image-upscale --image ./photo.png --wait --download ./out
```

Без `--wait` команда `run` сразу печатает `taskId`; дальше — асинхронный паттерн:

```bash
velsvisual status <taskId>     # статус (API определяется автоматически)
velsvisual wait <taskId>       # блокирующее ожидание, печатает resultUrls
velsvisual download <URL> -o file.png
```

URL результатов живут ограниченное время (~24 часа) — скачивайте сразу
(`--download КАТАЛОГ` вместе с `--wait`).

## Реестр моделей обновляется сам

Модели на kie.ai выходят каждую неделю, поэтому каталог не зашит в код:

- `velsvisual models` — показывает **живой реестр**: CLI скачивает каталог
  с https://docs.kie.ai/llms.txt и market-страницы документации.
- Кэш — `~/.velsvisual/models-cache.json`, авто-обновление раз в 24 часа;
  принудительно — `velsvisual models --refresh`.
- Если сети нет: свежий кэш → старый кэш → встроенный seed-реестр.
  Источник (`live`/`cache`/`seed`) и дата указываются в выводе.
- Метаданные seed-моделей (обязательные поля, тип API) всегда приоритетны;
  новые модели из каталога просто добавляются. Seed-модели, пропавшие из
  живого каталога, помечаются `[stale]` — они могли быть переименованы.
  Модели выделенных API (`suno`, `veo3*`, `flux-kontext-*`, `gpt4o-image`,
  `runway-gen3`) живут вне market-каталога и `[stale]` не помечаются.

## Новые модели работают без обновления CLI

`run` перед запуском читает схему модели из её документации (кэш
`~/.velsvisual/schema-cache.json`, TTL 24ч) и выводит из неё:

- куда положить `--prompt` (`prompt`, `text`, …) и `--image`
  (`image_url`, `image_urls`, `input_urls`, `first_frame_url`, `image`, …);
- какие поля обязательны — проверка происходит до сетевого запроса;
- обязательные поля, у которых есть значение по умолчанию, подставляются сами
  (иначе API отвечает 422 на, казалось бы, корректный запрос).

Поэтому модель, вышедшая на kie.ai вчера, вызывается обычным
`velsvisual run <новая-модель> --prompt ... --image ...`. Если модели нет
в кэше реестра, `run` обновит каталог сам. Флаги: `--no-schema` (не ходить
за схемой), `--refresh-schema` (обновить кэш), `--dry-run` (показать итоговый
запрос и ничего не отправлять).

Поля модели можно посмотреть напрямую:

```bash
velsvisual schema bytedance/seedance-2-mini          # таблица полей, enum, дефолты
velsvisual schema bytedance/seedance-2-mini --raw    # плюс сырой YAML схемы
```

Соответствие встроенного seed-реестра живым схемам проверяется скриптом
`npm run audit:registry` (ненулевой exit code, если что-то разошлось).

## Команды

| Команда                                                                                                                                                           | Назначение                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `velsvisual setup [--yes] [--local] [--repo РЕПО]`                                                                                                               | мастер настройки (ключ + скилл агента)                                   |
| `velsvisual credits`                                                                                                                                                 | баланс кредитов                                                                          |
| `velsvisual models [--refresh] [--category image\|video\|audio] [--search ТЕКСТ]`                                                                                 | живой реестр моделей                                                                 |
| `velsvisual recommend image\|video\|audio [--refresh]`                                                                                                          | подбор модели: последние версии популярных семейств с ценами и тиром качества        |
| `velsvisual pricing [--refresh] [--category image\|video\|audio] [--search ТЕКСТ]`                                                                              | цены моделей в кредитах и $ (живой прайс kie.ai, кэш 24ч)                            |
| `velsvisual schema МОДЕЛЬ [--raw]`                                                                                                                             | поля input модели из её документации                                         |
| `velsvisual upload ФАЙЛ`                                                                                                                                         | загрузка локального файла →`fileUrl`                                         |
| `velsvisual run МОДЕЛЬ [--prompt] [--image ...] [--set k=v ...] [--json-input JSON] [--dry-run] [--wait] [--timeout] [--interval] [--download КАТАЛОГ]` | создание задачи генерации                                                       |
| `velsvisual status TASK_ID [--api ...]`                                                                                                                              | статус; без`--api` — автоперебор jobs → veo → suno → gpt4o → flux → runway |
| `velsvisual wait TASK_ID [--timeout 600] [--interval 5] [--api ...]`                                                                                                 | polling до success/fail                                                                              |
| `velsvisual download URL [-o ПУТЬ]`                                                                                                                              | скачать файл                                                                                |
| `velsvisual config --set-key KEY`                                                                                                                                    | сохранить API-ключ                                                                        |

Общий флаг `--json` — машинный вывод JSON. При ошибке API — ненулевой exit code
и сообщение с `code`/`msg` (401 ключ, 402 кредиты, 422 валидация, 429 rate limit,
451 входное изображение, 455 maintenance, 501 генерация не удалась).

## Скилл для агента

Готовый скилл с инструкцией по работе с CLI: [`skills/visual/SKILL.md`](skills/visual/SKILL.md)
(входит в пакет). Установка и обновление:

```bash
velsvisual setup                          # мастер: ключ + скилл
npx -y skills add nick-vels/VelsVisual    # только скилл
npx -y skills update visual               # обновить установленный скилл
velsvisual setup --local                  # скопировать скилл из пакета в ./.agents/skills
```

Каталог моделей в скилл намеренно не зашит: актуальный список агент каждый раз
получает из живого реестра (`velsvisual models --refresh`), а поля конкретной
модели — из `velsvisual schema МОДЕЛЬ`.

## Тесты

```bash
npm test              # node:test, без сети
npm run audit:registry # сверка seed-реестра с живыми схемами docs.kie.ai (нужна сеть)
```
