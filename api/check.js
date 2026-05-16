const DEFAULT_ALLOWED_HOSTS = "telegra.ph";

const rateBuckets = new Map();

function parseAllowedHosts() {
  return String(process.env.ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS)
    .split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  res.status(status).json(body);
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function rateLimit(req, limit = Number(process.env.RATE_LIMIT_PER_MINUTE || 60)) {
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + 60_000 };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }

  bucket.count += 1;
  rateBuckets.set(ip, bucket);

  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt
  };
}

function validateUrl(input) {
  let url;

  try {
    url = new URL(String(input || ""));
  } catch {
    return { error: "Некорректный URL." };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { error: "Разрешены только http/https ссылки." };
  }

  const allowedHosts = parseAllowedHosts();
  const host = url.hostname.toLowerCase();

  const isAllowed = allowedHosts.some(allowed => {
    if (allowed === "*") return true;
    return host === allowed || host.endsWith("." + allowed);
  });

  if (!isAllowed) {
    return {
      error: `Домен ${host} запрещён. Добавь его в ALLOWED_HOSTS, если это твой домен.`,
      kind: "blocked"
    };
  }

  return { url };
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Number(process.env.CHECK_TIMEOUT_MS || 8500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "OwnLinkChecker/1.0 (+personal-link-checker)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function checkUrl(url) {
  const startedAt = performance.now();

  let response;

  try {
    response = await fetchWithTimeout(url, { method: "HEAD" });

    if ([405, 403].includes(response.status)) {
      response = await fetchWithTimeout(url, { method: "GET" });
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        kind: "timeout",
        status: "",
        latency: Math.round(performance.now() - startedAt),
        error: "Таймаут проверки."
      };
    }

    return {
      ok: false,
      kind: "network",
      status: "",
      latency: Math.round(performance.now() - startedAt),
      error: error?.message || "Ошибка сети."
    };
  }

  const status = response.status;
  const contentType = response.headers.get("content-type") || "";
  const finalUrl = response.url || url;

  return {
    ok: status >= 200 && status < 400,
    kind: status === 404 || status === 410 ? "not_found" : "http",
    status,
    finalUrl,
    contentType,
    latency: Math.round(performance.now() - startedAt)
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Используй POST." });
    return;
  }

  const limited = rateLimit(req);
  res.setHeader("X-RateLimit-Remaining", String(limited.remaining));

  if (!limited.allowed) {
    json(res, 429, {
      ok: false,
      kind: "rate_limited",
      error: "Слишком много проверок. Уменьши скорость или подожди минуту."
    });
    return;
  }

  const validation = validateUrl(req.body?.url);

  if (validation.error) {
    json(res, validation.kind === "blocked" ? 403 : 400, {
      ok: false,
      kind: validation.kind || "bad_request",
      error: validation.error
    });
    return;
  }

  const result = await checkUrl(validation.url.toString());
  json(res, 200, result);
}
