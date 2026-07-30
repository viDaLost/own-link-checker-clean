type CheckMode = "quick" | "full";

type RedirectHop = {
  status: number;
  url: string;
  location: string;
};

type CheckResult = {
  ok: boolean;
  category: string;
  label: string;
  originalUrl: string;
  normalizedUrl: string;
  finalUrl?: string;
  status?: number;
  statusText?: string;
  latency: number;
  method?: string;
  redirectCount?: number;
  redirectChain?: RedirectHop[];
  contentType?: string;
  contentLength?: number | null;
  checkedAt: string;
  diagnostic: string;
  cached?: boolean;
  cacheAgeMs?: number;
};

type CacheEntry = {
  createdAt: number;
  result: CheckResult;
};

type RateEntry = {
  windowStartedAt: number;
  runs: number;
  urls: number;
};

const MAX_URLS_PER_REQUEST = 200;
const MAX_CONCURRENCY = 12;
const MAX_REDIRECTS = 6;
const CHECK_TIMEOUT_MS = 9_000;
const SLOW_THRESHOLD_MS = 2_000;
const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 5_000;
const RATE_WINDOW_MS = 60_000;
const MAX_RUNS_PER_MINUTE = 20;
const MAX_URLS_PER_MINUTE = 3_000;

const cache = new Map<string, CacheEntry>();
const rateEntries = new Map<string, RateEntry>();
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const headFallbackStatuses = new Set([400, 403, 405, 406, 501]);

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

class TargetError extends Error {
  category: string;

  constructor(message: string, category = "blocked") {
    super(message);
    this.name = "TargetError";
    this.category = category;
  }
}

function isPrivateIpv4(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIpv6(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(":")) return false;
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/.test(host) ||
    host.startsWith("ff") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:192.168.")
  );
}

function normalizeTarget(input: unknown) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new TargetError("URL не указан.", "invalid_url");
  if (raw.length > 4_096) {
    throw new TargetError("URL превышает лимит в 4096 символов.", "invalid_url");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetError("Некорректный URL.", "invalid_url");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TargetError("Разрешены только HTTP и HTTPS.", "invalid_url");
  }
  if (url.username || url.password) {
    throw new TargetError("URL с логином или паролем заблокирован.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    blockedHostnames.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    throw new TargetError("Локальные и служебные адреса запрещены.");
  }

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!["80", "443"].includes(port)) {
    throw new TargetError(`Порт ${port} не разрешён.`);
  }

  url.hostname = host;
  url.hash = "";
  return url;
}

function classify(status: number, redirectCount: number, latency: number) {
  if (status >= 200 && status < 300) {
    if (latency >= SLOW_THRESHOLD_MS) {
      return {
        ok: true,
        category: "slow",
        label: "Медленно",
        diagnostic: `Ответ получен, но занял больше ${SLOW_THRESHOLD_MS / 1000} секунд.`,
      };
    }
    if (redirectCount > 0) {
      return {
        ok: true,
        category: "redirect",
        label: "Редирект",
        diagnostic: `URL доступен после ${redirectCount} перенаправлен${redirectCount === 1 ? "ия" : "ий"}.`,
      };
    }
    return {
      ok: true,
      category: "working",
      label: "Работает",
      diagnostic: "URL отвечает корректно.",
    };
  }
  if (status === 404 || status === 410) {
    return {
      ok: false,
      category: "not_found",
      label: status === 410 ? "Удалено" : "Не найдено",
      diagnostic: `Сервер вернул HTTP ${status}.`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      category: "blocked",
      label: "Доступ закрыт",
      diagnostic: `Сервер ограничил доступ (HTTP ${status}).`,
    };
  }
  if (status >= 400 && status < 500) {
    return {
      ok: false,
      category: "client_error",
      label: "Ошибка 4xx",
      diagnostic: `Сервер вернул клиентскую ошибку HTTP ${status}.`,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      category: "server_error",
      label: "Ошибка 5xx",
      diagnostic: `Сервер вернул внутреннюю ошибку HTTP ${status}.`,
    };
  }
  return {
    ok: false,
    category: "network_error",
    label: "Неожиданный ответ",
    diagnostic: `Получен HTTP ${status}.`,
  };
}

async function fetchHeaders(
  url: URL,
  method: "HEAD" | "GET",
  signal: AbortSignal,
) {
  const response = await fetch(url.toString(), {
    method,
    redirect: "manual",
    signal,
    headers:
      method === "GET"
        ? {
            accept: "*/*",
            range: "bytes=0-2047",
            "user-agent": "LinkPulse/3.0",
          }
        : {
            accept: "*/*",
            "user-agent": "LinkPulse/3.0",
          },
  });
  return response;
}

async function requestTarget(startUrl: URL, signal: AbortSignal) {
  let current = startUrl;
  let method: "HEAD" | "GET" = "HEAD";
  const redirectChain: RedirectHop[] = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response = await fetchHeaders(current, method, signal);
    if (method === "HEAD" && headFallbackStatuses.has(response.status)) {
      response.body?.cancel();
      method = "GET";
      response = await fetchHeaders(current, method, signal);
    }

    if (!redirectStatuses.has(response.status)) {
      return { response, current, method, redirectChain };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { response, current, method, redirectChain };
    }
    if (hop === MAX_REDIRECTS) {
      response.body?.cancel();
      throw new TargetError("Превышен лимит перенаправлений.", "redirect_error");
    }

    const next = normalizeTarget(new URL(location, current).toString());
    redirectChain.push({
      status: response.status,
      url: current.toString(),
      location: next.toString(),
    });
    response.body?.cancel();
    current = next;
    if (response.status === 303) method = "GET";
  }

  throw new TargetError("Не удалось завершить цепочку редиректов.", "redirect_error");
}

async function checkUrl(
  input: unknown,
  mode: CheckMode,
  force: boolean,
  requestSignal: AbortSignal,
): Promise<CheckResult> {
  const originalUrl = String(input ?? "").trim();
  let normalized: URL;
  try {
    normalized = normalizeTarget(originalUrl);
  } catch (error) {
    const targetError = error as TargetError;
    return {
      ok: false,
      category: targetError.category || "invalid_url",
      label: targetError.category === "invalid_url" ? "Некорректный URL" : "Заблокировано",
      originalUrl,
      normalizedUrl: originalUrl,
      latency: 0,
      checkedAt: new Date().toISOString(),
      diagnostic: targetError.message,
    };
  }

  const cacheKey = `${mode}:${normalized.toString()}`;
  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return {
      ...cached.result,
      cached: true,
      cacheAgeMs: Date.now() - cached.createdAt,
      checkedAt: new Date().toISOString(),
    };
  }

  const startedAt = performance.now();
  const timeoutController = new AbortController();
  const onAbort = () => timeoutController.abort(requestSignal.reason);
  requestSignal.addEventListener("abort", onAbort, { once: true });
  const timeoutId = setTimeout(
    () => timeoutController.abort(new DOMException("Timeout", "TimeoutError")),
    CHECK_TIMEOUT_MS,
  );

  try {
    const { response, current, method, redirectChain } = await requestTarget(
      normalized,
      timeoutController.signal,
    );
    const latency = Math.round(performance.now() - startedAt);
    const statusInfo = classify(response.status, redirectChain.length, latency);
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader
      ? Number.parseInt(contentLengthHeader, 10)
      : null;

    const result: CheckResult = {
      ...statusInfo,
      originalUrl,
      normalizedUrl: normalized.toString(),
      finalUrl: current.toString(),
      status: response.status,
      statusText: response.statusText,
      latency,
      method,
      redirectCount: redirectChain.length,
      redirectChain,
      contentType:
        mode === "full"
          ? response.headers.get("content-type") || undefined
          : undefined,
      contentLength:
        mode === "full" && Number.isFinite(contentLength)
          ? contentLength
          : undefined,
      checkedAt: new Date().toISOString(),
      cached: false,
    };
    response.body?.cancel();

    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
    cache.set(cacheKey, { result, createdAt: Date.now() });
    return result;
  } catch (error) {
    const elapsed = Math.round(performance.now() - startedAt);
    const value = error as Error;
    const timedOut =
      timeoutController.signal.reason?.name === "TimeoutError" ||
      value?.name === "TimeoutError" ||
      elapsed >= CHECK_TIMEOUT_MS - 100;
    const targetError = error instanceof TargetError ? error : null;
    return {
      ok: false,
      category: targetError?.category || (timedOut ? "timeout" : "network_error"),
      label: targetError
        ? targetError.category === "redirect_error"
          ? "Ошибка редиректа"
          : "Заблокировано"
        : timedOut
          ? "Тайм-аут"
          : "Ошибка сети",
      originalUrl,
      normalizedUrl: normalized.toString(),
      latency: elapsed,
      checkedAt: new Date().toISOString(),
      diagnostic:
        targetError?.message ||
        (timedOut
          ? `Сайт не ответил за ${CHECK_TIMEOUT_MS / 1000} секунд.`
          : "Не удалось установить соединение или получить ответ."),
    };
  } finally {
    clearTimeout(timeoutId);
    requestSignal.removeEventListener("abort", onAbort);
  }
}

function getClientKey(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

function consumeRateLimit(key: string, urlCount: number) {
  const now = Date.now();
  const current = rateEntries.get(key);
  const entry =
    !current || now - current.windowStartedAt >= RATE_WINDOW_MS
      ? { windowStartedAt: now, runs: 0, urls: 0 }
      : current;

  entry.runs += 1;
  entry.urls += urlCount;
  rateEntries.set(key, entry);
  return (
    entry.runs <= MAX_RUNS_PER_MINUTE &&
    entry.urls <= MAX_URLS_PER_MINUTE
  );
}

function uniqueEntries(values: unknown[]) {
  const entries: Array<{
    originalUrl: string;
    normalizedUrl: string;
    occurrences: number;
  }> = [];
  const positions = new Map<string, number>();

  for (const value of values) {
    const originalUrl = String(value ?? "").trim();
    if (!originalUrl) continue;
    let normalizedUrl = originalUrl;
    try {
      normalizedUrl = normalizeTarget(originalUrl).toString();
    } catch {
      // Invalid targets still need a diagnostic result.
    }
    const existing = positions.get(normalizedUrl);
    if (existing !== undefined) {
      entries[existing].occurrences += 1;
    } else {
      positions.set(normalizedUrl, entries.length);
      entries.push({ originalUrl, normalizedUrl, occurrences: 1 });
    }
  }
  return entries;
}

export async function POST(request: Request) {
  let body: {
    urls?: unknown[];
    mode?: CheckMode;
    concurrency?: number;
    force?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Ожидался JSON-запрос." },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.urls) || body.urls.length === 0) {
    return Response.json(
      { ok: false, error: "Передайте непустой массив urls." },
      { status: 400 },
    );
  }
  if (body.urls.length > MAX_URLS_PER_REQUEST) {
    return Response.json(
      {
        ok: false,
        error: `Один потоковый пакет поддерживает до ${MAX_URLS_PER_REQUEST} URL.`,
      },
      { status: 413 },
    );
  }
  if (!consumeRateLimit(getClientKey(request), body.urls.length)) {
    return Response.json(
      {
        ok: false,
        error: "Слишком много проверок за минуту. Подождите немного и повторите.",
      },
      { status: 429 },
    );
  }

  const entries = uniqueEntries(body.urls);
  const mode: CheckMode = body.mode === "full" ? "full" : "quick";
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Number(body.concurrency) || 6),
    entries.length,
  );
  const force = body.force === true;
  const runId = crypto.randomUUID();
  const encoder = new TextEncoder();
  const startedAt = performance.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      let cursor = 0;
      const stats = {
        total: entries.length,
        checked: 0,
        success: 0,
        redirects: 0,
        errors: 0,
        cached: 0,
        remaining: entries.length,
      };

      send({ type: "start", runId, mode, concurrency, stats });

      const worker = async () => {
        while (!request.signal.aborted) {
          const index = cursor;
          cursor += 1;
          if (index >= entries.length) return;
          const entry = entries[index];
          const result = await checkUrl(
            entry.originalUrl,
            mode,
            force,
            request.signal,
          );
          stats.checked += 1;
          stats.remaining = Math.max(0, stats.total - stats.checked);
          if (result.category === "redirect") stats.redirects += 1;
          else if (result.ok) stats.success += 1;
          else stats.errors += 1;
          if (result.cached) stats.cached += 1;
          const elapsedSeconds = Math.max(
            0.001,
            (performance.now() - startedAt) / 1000,
          );
          send({
            type: "result",
            runId,
            index,
            entry,
            result,
            stats: {
              ...stats,
              speed: stats.checked / elapsedSeconds,
              etaSeconds:
                stats.remaining / Math.max(stats.checked / elapsedSeconds, 0.001),
            },
          });
        }
      };

      try {
        await Promise.all(Array.from({ length: concurrency }, worker));
        send({
          type: request.signal.aborted ? "cancelled" : "done",
          runId,
          stats,
          durationMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        send({
          type: "error",
          runId,
          error:
            error instanceof Error
              ? error.message
              : "Не удалось завершить проверку.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      "x-run-id": runId,
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "POST, OPTIONS",
    },
  });
}
