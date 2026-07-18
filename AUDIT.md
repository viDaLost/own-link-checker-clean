# Аудит и отчёт об изменениях

## 1. Аудит исходного проекта

Исходный проект состоял из одного `index.html`, одной Vercel-функции `api/check.js`, `package.json` и `vercel.json`. Frontend генерировал URL преимущественно по шаблону, запускал максимум три worker и отправлял отдельный POST для каждой ссылки. После каждого URL выполнялась искусственная пауза 900 мс.

### Обнаруженные проблемы

| Проблема | Влияние | Приоритет | Затронутые исходные модули |
|---|---|---:|---|
| Искусственная задержка 900 мс и только три worker | 100 URL занимали 32,271 с при сетевой медиане 49 мс | P0 | `index.html` |
| Один serverless-вызов на каждый URL | Лишние API/TLS/HTTP накладные расходы и расход invocation quota | P0 | `index.html`, `api/check.js` |
| Автоматическое следование редиректам до проверки конечной цели | Публичный URL мог перенаправить запрос во внутреннюю сеть | P0 | `api/check.js` |
| При `ALLOWED_HOSTS=*` не проверялись private/loopback/link-local IP | Прямой SSRF к localhost, частным сетям и metadata endpoints | P0 | `api/check.js` |
| GET fallback не ограничивал тело ответа | Риск скачивания больших ответов, роста памяти и времени | P0 | `api/check.js` |
| Не было backend-потока результатов и отмены | Клиент ждал отдельные API-вызовы, сервер не имел единого состояния запуска | P0 | архитектура целиком |
| Не было дедупликации, кэша, retry/backoff и `Retry-After` | Повторная нагрузка и ложные ошибки на временных сбоях | P1 | `index.html`, `api/check.js` |
| Один общий timeout | Слабая диагностика DNS/connect/headers/read/TLS | P1 | `api/check.js` |
| Полный пересчёт и рендер массива при частых обновлениях | Main thread деградировал бы на сотнях и тысячах URL | P1 | `index.html` |
| Широкая таблица на мобильных устройствах | Плохая читаемость и риск горизонтального скролла | P1 | `index.html` |
| Нет обычного многострочного импорта, фильтров и массовых действий | Сервис не покрывал основной SaaS-сценарий | P1 | `index.html` |
| Нет тестов | Высокий риск регрессий и недоказуемая безопасность | P1 | проект целиком |

## 2. Приоритетный план

### Критические

1. Закрыть SSRF через DNS, literal IP и каждый redirect hop.
2. Перейти на один потоковый batch endpoint с ограниченным параллелизмом.
3. Добавить connection pooling, keep-alive, body limits и разделённые timeout.
4. Реализовать отмену, retry/backoff и rate limiting по запускам и объёму URL.

### Важные

1. Дедупликация, краткосрочный кэш и подробная диагностика.
2. Импорт TXT/CSV/sitemap.xml, фильтры, сортировка, массовая перепроверка и экспорт.
3. Mobile-first карточки, пакетный рендер и pagination.
4. Unit/integration-тесты и воспроизводимый benchmark.

### Дополнительные

1. Локальная история по явному согласию.
2. Сохранение шаблонного генератора как вторичного сценария.
3. Светлая/тёмная тема и token-based визуальная система.

## 3. Реализованные изменения

### Backend и архитектура

- `lib/security.js`: нормализация URL, ограничения протоколов/портов/доменов, проверка всех DNS-ответов, блокировка private/loopback/link-local/multicast/reserved/CGNAT IPv4 и private/link-local IPv6, безопасный DNS lookup для защиты от rebinding.
- `lib/checker.js`: единый `undici.Agent`, keep-alive и connection pooling; HEAD с fallback на ограниченный GET; ручные редиректы; retry с exponential backoff, jitter и `Retry-After`; общий deadline и отдельные DNS/connect/headers/read/TLS timeout; лимит ответа; категории ошибок; TLS-диагностика; краткосрочный кэш.
- `api/check-batch.js`: NDJSON streaming, `runId`, дедупликация, общий и per-host pool, live progress/speed/ETA, отмена незавершённых задач при disconnect, защита от двойной/чрезмерной нагрузки.
- `api/check.js`: совместимый single-URL endpoint на новом движке.
- `lib/rate-limit.js`: лимиты запусков, количества URL и активных задач на IP с очисткой bucket state.
- `lib/config.js` и `.env.example`: конфигурируемые лимиты без смены serverless-стека.

### Frontend и продукт

- `index.html`: новый первый экран, обычный textarea, drag-and-drop, режимы проверки, реальный progress block, фильтры, bulk actions, mobile cards, dialogs и доступная семантика.
- `assets/app.js`: потоковый NDJSON-клиент, отмена, повтор selected/errors, поиск, фильтры, сортировка, selection, CSV/JSON/TXT export, принудительная проверка без кэша, локальная opt-in история, throttled render каждые 100 мс.
- `assets/import-worker.js`: разбор TXT/CSV/XML вне main thread.
- `assets/utils.js`: извлечение URL, безопасная дедупликация и защита CSV от formula injection.
- `assets/styles.css`: дизайн-токены, responsive SaaS UI, карточки на мобильных, области нажатия, focus-visible, статусы с цветом/иконкой/текстом, safe-area и `prefers-reduced-motion`.
- Результаты ограничены pagination (25–250 строк), поэтому тысячи DOM-элементов одновременно не создаются.
- Добавлено отдельное состояние «ничего не найдено по фильтрам» с быстрым сбросом.

### Тесты и документация

- `tests/`: 26 unit/integration-тестов backend, streaming API, SSRF, rate limiting и frontend utilities.
- `benchmarks/`: исходные и новые результаты для 100 и 1 000 URL, сравнение и методика.
- `README.md`: запуск, архитектура, API, безопасность, ограничения.
- `vercel.json`: увеличенный duration для batch streaming, CSP и security headers.

## 4. Ускорение

Контролируемый локальный стенд использовал один и тот же набор URL с задержками 20–68 мс, смешанными 200/404, редиректами и частью HEAD→GET. Это измеряет накладные расходы приложения и стратегию конкурентности; скорость публичных сайтов зависит от их latency, DNS и rate limits.

| Метрика | До | После | Изменение |
|---|---:|---:|---:|
| Время проверки 100 URL | 32,271 с | 1,251 с | −96,1% |
| Время проверки 1 000 URL | 317,430 с | 12,022 с | −96,2% |
| URL в секунду, 100 URL | 3,10 | 79,93 | 25,8× |
| URL в секунду, 1 000 URL | 3,15 | 83,18 | 26,4× |
| Медианное время, 1 000 URL | 48,3 мс | 46,0 мс | −4,8% |
| p95, 1 000 URL | 73,1 мс | 71,0 мс | −2,9% |
| Peak RSS, 1 000 URL | 159,82 МБ | 169,68 МБ | +6,2% |
| CPU, 1 000 URL | 29 450 мс | 3 390 мс | −88,5% |

Небольшой рост peak RSS — ожидаемая цена пула соединений и одновременно активных задач. При переходе со 100 к 1 000 URL peak RSS новой версии не рос линейно: 173,32 МБ и 169,68 МБ соответственно.

## 5. Функциональные улучшения

- Одна ссылка, многострочный список, вставка из буфера, TXT, CSV, sitemap.xml и drag-and-drop.
- Предварительный подсчёт уникальных URL и дубликатов.
- Быстрый и полный режимы.
- Реальный поток результатов, процент, checked/total, success/redirect/error/remaining, скорость и ETA по фактическим данным.
- Остановка текущего запуска с сохранением уже полученных результатов.
- Повтор отдельной строки, выбранных строк или всех ошибок.
- Поиск, категории, домен, диапазон latency, сортировка и сброс фильтров.
- Массовое копирование, перенос в новый запуск, удаление строк.
- Экспорт всех, отфильтрованных, выбранных или ошибочных результатов в CSV/JSON/TXT.
- Кэш с отметкой возраста и принудительным bypass.
- Локальная история только по opt-in, максимум 10 запусков и 7 дней.

## 6. Мобильная версия

- Ввод получил удобную высоту, 16 px шрифт для предотвращения автозума iOS, заметные Paste/Upload/Start actions и полноширинную основную кнопку.
- После запуска фокус внимания переводится к progress card.
- Десктопная таблица на ширине до 760 px заменяется карточками: статус, URL/домен, HTTP, latency, redirects и раскрываемые детали.
- Фильтры перестраиваются в одну/две колонки; массовые действия — в компактную сетку.
- Размеры кнопок и контролов ориентированы на область нажатия около 44 px; учтён `env(safe-area-inset-bottom)`.
- Breakpoints и отсутствие заведомого page-level horizontal overflow проверены статически для 320, 360, 375, 390, 430, 768, 1024 и 1440 px.
- Реальный Chromium viewport-run в этой sandbox-среде не состоялся: браузер не запускался даже на `data:` URL из-за ограничений system sandbox/network namespace. Поэтому визуальный screenshot/E2E тест не заявляется как выполненный.

## 7. Безопасность

Реализовано:

- только HTTP/HTTPS; запрет credentials и опасных схем;
- блокировка localhost, внутренних suffix и cloud metadata hostnames;
- блокировка literal и DNS-resolved внутренних/служебных IPv4/IPv6;
- проверка всех DNS-ответов и безопасный custom lookup;
- повторная валидация каждого redirect target;
- лимиты URL, портов, редиректов, ответа, времени, конкурентности и активных jobs;
- rate limiting по запускам и объёму URL;
- отсутствие внутренних stack traces по умолчанию;
- CSP, `nosniff`, запрет framing, строгая referrer/permissions policy;
- экранирование URL в интерфейсе и защита CSV formula injection;
- история выключена по умолчанию и хранится только локально после согласия.

Оставшиеся ограничения:

- in-memory rate limit/cache не глобальны между serverless instances;
- durable очередь и результаты после перезагрузки страницы требуют Redis/DB/worker;
- allowlist доменов рекомендуется для закрытых корпоративных установок.

## 8. Тестирование

Выполнено:

- `npm test`: 26/26 успешно;
- `npm audit --omit=dev`: 0 известных уязвимостей;
- `node --check` для всех JS/MJS файлов: успешно;
- интеграционный NDJSON-прогон start/result/done с дедупликацией;
- benchmark до/после для 100 и 1 000 URL;
- статическая проверка DOM: уникальные id, отсутствие inline scripts/styles, соответствие JS-ссылок существующим элементам.

Покрытые сценарии: 2xx, 404, timeout, invalid URL, HEAD fallback, redirects, redirect loop, redirect к private IP, retries 503, response cap, cancellation, TLS error, cache/force, dedupe, rate limits, active jobs, sitemap/CSV/text parsing и CSV formula injection.

Не выполнено в данной среде: настоящий браузерный E2E с Playwright/Chromium и проверка реальных внешних сайтов. Их следует запускать в CI или staging без sandbox-ограничений.

## 9. Следующие шаги

1. Вынести jobs/cache/rate limits в Redis и worker queue, если требуется переживать reload/deploy и масштабироваться на несколько instances.
2. Добавить ограниченный crawler отдельным worker: robots policy, max depth/pages/time, per-origin politeness и хранение source page/selector.
3. Добавить Playwright matrix и Lighthouse/axe в CI для реальных viewport и accessibility regression checks.
