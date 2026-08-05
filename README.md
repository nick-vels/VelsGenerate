```
__     _______ _     ____   ____ _____ _   _ _____ ____      _  _____ _____
\ \   / / ____| |   / ___| / ___| ____| \ | | ____|  _ \    / \|_   _| ____|
 \ \ / /|  _| | |   \___ \| |  _|  _| |  \| |  _| | |_) |  / _ \ | | |  _|
  \ V / | |___| |___ ___) | |_| | |___| |\  | |___|  _ <  / ___ \| | | |___
   \_/  |_____|_____|____/ \____|_____|_| \_|_____|_| \_\/_/   \_\_| |_____|
```

# VelsGenerate

CLI на Node.js для генерации **фото, видео и аудио** через [KIE API](https://kie.ai) (docs.kie.ai).
Один инструмент поверх всех API платформы: универсальный Market API (jobs), Seedance,
GPT Image, Wan, Suno, ElevenLabs и десятки других моделей.
**Ноль runtime-зависимостей** — только Node.js >= 18.

## Установка и онбординг — одной командой

```bash
npx -y velsgenerate setup
```

`npx` скачает CLI и сразу запустит мастер настройки (см. ниже). Для постоянной
установки после этого: `npm i -g velsgenerate`. Из исходников: `npm install -g .`
в корне репозитория. Если пакет уже установлен — мастер доступен как
`velsgenerate setup` (alias: `init`).

Мастер проведёт по шагам:

1. **API-ключ** — предложит взять `KIE_API_KEY` из окружения или ввести вручную
   (ключ выдаётся на https://kie.ai/api-key), проверит его запросом баланса
   и сохранит в `~/.velsgenerate/config.json` (chmod 600).
2. **Скилл для агента** — установит скилл `generate` через `npx skills add <repo>`
   или скопирует его из пакета локально (`velsgenerate setup --local`).
3. Покажет сводку и пример первой генерации.

Неинтерактивный режим: `velsgenerate setup --yes` (берёт ключ из env).
Без мастера: `export KIE_API_KEY=ваш_ключ` или `velsgenerate config --set-key ваш_ключ`.

## Примеры

```bash
# Картинка (text-to-image) — создать задачу, дождаться, скачать в ./out
velsgenerate run google/nano-banana --prompt "рыжий кот в скафандре, кинематографично" \
  --wait --download ./out

# Видео из картинки: локальный файл будет сначала загружен через upload API
velsgenerate run veo3_fast --prompt "кот машет лапой" --image ./cat.png \
  --set aspect_ratio=16:9 --wait --timeout 900 --download ./out

# Музыка (Suno, custom mode)
velsgenerate run suno --prompt "песня про осенний город" \
  --set customMode=true --set style="indie rock, female vocal" --set title="Осень" \
  --wait --download ./out

# Озвучка (ElevenLabs TTS)
velsgenerate run elevenlabs/text-to-speech-turbo-2-5 \
  --prompt "Привет! Это тестовая озвучка." --wait --download ./out

# Апскейл изображения
velsgenerate run topaz/image-upscale --image ./photo.png --wait --download ./out
```

Без `--wait` команда `run` сразу печатает `taskId`; дальше — асинхронный паттерн:

```bash
velsgenerate status <taskId>     # статус (API определяется автоматически)
velsgenerate wait <taskId>       # блокирующее ожидание, печатает resultUrls
velsgenerate download <URL> -o file.png
```

URL результатов живут ограниченное время (~24 часа) — скачивайте сразу
(`--download КАТАЛОГ` вместе с `--wait`).

## Реестр моделей обновляется сам

Модели на kie.ai выходят каждую неделю, поэтому каталог не зашит в код:

- `velsgenerate models` — показывает **живой реестр**: CLI скачивает каталог
  с https://docs.kie.ai/llms.txt и market-страницы документации.
- Кэш — `~/.velsgenerate/models-cache.json`, авто-обновление раз в 24 часа;
  принудительно — `velsgenerate models --refresh`.
- Если сети нет: свежий кэш → старый кэш → встроенный seed-реестр.
  Источник (`live`/`cache`/`seed`) и дата указываются в выводе.
- Метаданные seed-моделей (обязательные поля, тип API) всегда приоритетны;
  новые модели из каталога просто добавляются. Seed-модели, пропавшие из
  живого каталога, помечаются `[stale]` — они могли быть переименованы.
- Для новых моделей (api `jobs`) валидация мягкая: `--prompt` работает,
  остальные поля добираются через `--set ключ=значение` или `--json-input '{"..."}'`.

## Команды

| Команда                                                                                                                                               | Назначение                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `velsgenerate setup [--yes] [--local] [--repo РЕПО]`                                                                                                   | мастер настройки (ключ + скилл агента)                                   |
| `velsgenerate credits`                                                                                                                                     | баланс кредитов                                                                          |
| `velsgenerate models [--refresh] [--category image\|video\|audio] [--search ТЕКСТ]`                                                                     | живой реестр моделей                                                                 |
| `velsgenerate upload ФАЙЛ`                                                                                                                             | загрузка локального файла →`fileUrl`                                         |
| `velsgenerate run МОДЕЛЬ [--prompt] [--image ...] [--set k=v ...] [--json-input JSON] [--wait] [--timeout] [--interval] [--download КАТАЛОГ]` | создание задачи генерации                                                       |
| `velsgenerate status TASK_ID [--api ...]`                                                                                                                  | статус; без`--api` — автоперебор jobs → veo → suno → gpt4o → flux → runway |
| `velsgenerate wait TASK_ID [--timeout 600] [--interval 5] [--api ...]`                                                                                     | polling до success/fail                                                                              |
| `velsgenerate download URL [-o ПУТЬ]`                                                                                                                  | скачать файл                                                                                |
| `velsgenerate config --set-key KEY`                                                                                                                        | сохранить API-ключ                                                                        |

Общий флаг `--json` — машинный вывод JSON. При ошибке API — ненулевой exit code
и сообщение с `code`/`msg` (401 ключ, 402 кредиты, 422 валидация, 429 rate limit,
451 входное изображение, 455 maintenance, 501 генерация не удалась).

## Скилл для агента

Готовый скилл с инструкцией по работе с CLI: [`skills/generate/SKILL.md`](skills/generate/SKILL.md)
(в пакете) — ставится через `velsgenerate setup`. Каталог моделей в скилл намеренно
не зашит: актуальный список агент каждый раз получает из живого реестра —
`velsgenerate models --refresh`.

## Тесты

```bash
npm test          # node:test, без сети
```
