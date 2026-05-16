# Own Link Checker — Vercel Fixed

Это чистая версия для Vercel.

## Файлы

- `index.html` — интерфейс приложения.
- `api/check.js` — серверная функция проверки ссылок.
- `package.json` — минимальная настройка Node.js runtime.
- `vercel.json` — настройки Vercel.

## Важно

В этой версии нет `server.js`, потому что он нужен только для обычного VPS/Node-сервера.
На Vercel `server.js` может перехватить главную страницу, и вместо интерфейса появится:

```json
{"ok":false,"error":"Endpoint not found. Use /api/check"}
```

## Environment Variables в Vercel

Добавь:

```text
ALLOWED_HOSTS=telegra.ph
RATE_LIMIT_PER_MINUTE=60
CHECK_TIMEOUT_MS=8500
CORS_ORIGIN=*
```

После изменения переменных сделай Redeploy.

## Проверка

Главная страница:

```text
https://твой-проект.vercel.app/
```

API endpoint:

```text
https://твой-проект.vercel.app/api/check
```

`/api/check` открывать в браузере не нужно — он принимает POST-запросы из приложения.
