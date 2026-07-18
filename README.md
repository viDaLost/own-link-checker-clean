# LinkPulse — быстрый и безопасный link checker

LinkPulse проверяет до 1 000 URL за запуск, передаёт результаты потоком и не блокирует интерфейс во время больших проверок. Проект остаётся без frontend-сборки: статический HTML/CSS/ES modules и Node.js serverless functions для Vercel.

## Что изменилось в версии 2.0

- Пакетный endpoint `POST /api/check-batch` с NDJSON streaming.
- Ограниченный общий параллелизм и отдельный лимит запросов к одному хосту.
- Повторно используемый `undici.Agent`: keep-alive, connection pooling и безопасный DNS lookup.
- HEAD с fallback на ограниченный GET.
- Ручная обработка редиректов с SSRF-проверкой каждого перехода.
- Раздельные тайм-ауты DNS/connect/headers/read/TLS и общий deadline.
- Повторы только для временных сетевых ошибок, 408, 429 и отдельных 5xx; поддерживается `Retry-After`.
- Краткосрочный кэш с принудительной перепроверкой.
- Дедупликация URL с сохранением числа повторений.
- Отмена проверки, повтор ошибок/выбранных URL, фильтры, сортировка и экспорт CSV/JSON/TXT.
- Импорт TXT, CSV и sitemap.xml через Web Worker.
- Mobile-first карточки результатов вместо широкой таблицы.
- Локальная история по явному opt-in, автоматически ограниченная 10 запусками и 7 днями.
- CSP, дополнительные security headers и 26 автоматических тестов.

## Архитектура

```text
Browser
  ├─ index.html + assets/app.js + assets/styles.css
  ├─ Web Worker для разбора больших файлов
  └─ POST /api/check-batch (application/x-ndjson)
                  │
                  ▼
Batch worker pool
  ├─ global concurrency limit
  ├─ per-host concurrency limit
  ├─ deduplication + progress stats
  └─ AbortSignal on disconnect
                  │
                  ▼
Safe URL checker
  ├─ protocol/host/port validation
  ├─ DNS resolution + public-IP enforcement
  ├─ custom undici lookup (DNS rebinding protection)
  ├─ manual redirect validation
  ├─ HEAD → limited GET
  ├─ retries/backoff/jitter
  └─ in-memory result cache
```

## Локальный запуск

Требуется Node.js 20.18.1 или новее.

```bash
npm install
npm test
npm run dev
```

Откройте `http://127.0.0.1:3000`.

Локальный dev server сохраняет те же SSRF-ограничения, что и production. Приватные адреса разрешаются только в автоматических тестах при одновременных `NODE_ENV=test` и `ALLOW_PRIVATE_NETWORKS_FOR_TESTS=true`.

## Vercel

1. Импортируйте репозиторий.
2. При необходимости скопируйте значения из `.env.example` в Environment Variables.
3. Выполните deploy.

`ALLOWED_HOSTS=*` разрешает любые публичные HTTP/HTTPS-хосты. Для закрытого инструмента безопаснее задать allowlist, например:

```text
ALLOWED_HOSTS=example.com,example.org
```

По умолчанию разрешены только порты 80 и 443. Нестандартные публичные порты добавляются явно через `ALLOWED_PORTS`.

## API

### Одиночная проверка

```http
POST /api/check
Content-Type: application/json

{
  "url": "https://example.com",
  "mode": "quick",
  "force": false
}
```

### Потоковая пакетная проверка

```http
POST /api/check-batch
Content-Type: application/json

{
  "urls": ["https://example.com", "https://example.com/missing"],
  "mode": "quick",
  "concurrency": 12,
  "force": false
}
```

Ответ — строки NDJSON с типами `start`, `result`, `done` или `error`.

## Безопасность

Проверка произвольных URL является SSRF-sensitive операцией. Реализованы:

- запрет протоколов кроме HTTP/HTTPS;
- запрет credentials в URL;
- блокировка localhost, `.local`, `.internal`, `.lan`, `.home` и metadata hostnames;
- блокировка loopback, private, link-local, multicast, reserved, CGNAT и private IPv6;
- проверка всех DNS-ответов, а не только первого;
- custom DNS lookup в HTTP-клиенте, чтобы соединение использовало только уже проверенный публичный IP;
- повторная проверка цели на каждом редиректе;
- лимиты портов, редиректов, тела ответа, времени, URL, конкурентности и активных запусков;
- отсутствие stack traces и серверных секретов в ответах;
- безопасное отображение URL без `innerHTML` в окне диагностики;
- CSP и запрет встраивания страницы во фреймы.

Rate limiting, кэш и active-job counters находятся в памяти конкретного serverless instance. Для глобальных лимитов и долговременных задач нужен внешний Redis/queue/storage.

## Тесты и benchmark

```bash
npm test
npm run benchmark -- 100
npm run benchmark -- 1000
```

Benchmark использует локальный контролируемый HTTP-сервер с предсказуемыми задержками и смешанными ответами 200/404/405. Результаты текущего прогона сохранены в `benchmarks/`.

## Известные ограничения

- Текущая serverless-версия не переживает обновление страницы и не хранит очередь во внешней базе.
- Глобальная синхронизация rate limit/cache между разными Vercel instances отсутствует.
- Нет бесконтрольного crawler: импортируются файлы sitemap, но обход домена намеренно не включён без durable queue и robots/politeness policy.
- XLSX не добавлен, поскольку CSV/JSON покрывают экспорт без тяжёлой клиентской зависимости.
