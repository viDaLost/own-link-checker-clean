# LinkPulse

Премиальный потоковый проверщик ссылок на Next.js. Проект хранится в GitHub и
автоматически публикуется в Vercel при каждом изменении ветки `main`.

## Возможности

- потоковая проверка до 200 URL за один запуск;
- быстрый и подробный режимы;
- проверка HTTP-статуса, редиректов, задержки и заголовков;
- фильтрация, поиск, сортировка и экспорт результатов;
- история запусков и пользовательские настройки в браузере;
- тёмная и светлая темы, акцентные цвета и четыре фоновых стиля;
- адаптивный интерфейс для телефона, планшета и компьютера;
- серверная защита от локальных адресов, нестандартных портов и опасных URL.

## Локальный запуск

Требуется Node.js 22.

```bash
npm ci
npm run dev
```

Откройте [http://localhost:3000](http://localhost:3000).

## Проверки

```bash
npm run lint
npm run typecheck
npm test
```

`npm test` собирает production-версию, запускает её через `next start` и
проверяет главную страницу и потоковый API `/api/check-batch`.

## Публикация в Vercel

1. Подключите репозиторий `viDaLost/own-link-checker-clean` в Vercel.
2. Выберите production-ветку `main`.
3. Оставьте корневую директорию проекта `./`.
4. Убедитесь, что Framework Preset установлен в `Next.js`.
5. Удалите ручное значение Output Directory — для Next.js Vercel определяет его
   автоматически.
6. Запустите Redeploy последнего коммита или отправьте новый коммит в `main`.

Файл `vercel.json` фиксирует необходимые настройки:

| Параметр | Значение |
| --- | --- |
| Framework | `nextjs` |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Node.js | `22.x` |
| Output Directory | определяется Vercel |

Переменные окружения для базовой работы не требуются.

## Архитектура

- `app/page.tsx` — клиентский интерфейс;
- `app/globals.css` — темы, адаптивность и визуальные стили;
- `app/api/check-batch/route.ts` — Vercel Function с NDJSON-потоком результатов;
- `public/wallpapers/` — фоновые изображения;
- `public/fonts/` — локальные Geist-шрифты без внешней загрузки при сборке;
- `next.config.ts` — production-настройки Next.js и заголовки безопасности;
- `vercel.json` — настройки автоматического деплоя.

## API

`POST /api/check-batch`

```json
{
  "urls": ["https://example.com"],
  "mode": "quick",
  "concurrency": 6,
  "force": false
}
```

Ответ возвращается как `application/x-ndjson`: события `start`, `result` и
`done` поступают по мере выполнения проверки.
