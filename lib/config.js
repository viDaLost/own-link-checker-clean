const numberFromEnv = (name, fallback, min, max) => {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const listFromEnv = (name, fallback) => String(process.env[name] ?? fallback)
  .split(",")
  .map(value => value.trim().toLowerCase())
  .filter(Boolean);

export function getConfig() {
  return {
    allowedHosts: listFromEnv("ALLOWED_HOSTS", "*"),
    allowedPorts: listFromEnv("ALLOWED_PORTS", "80,443"),
    maxUrlLength: numberFromEnv("MAX_URL_LENGTH", 4096, 256, 16384),
    maxUrlsPerRun: numberFromEnv("MAX_URLS_PER_RUN", 1000, 1, 10000),
    defaultConcurrency: numberFromEnv("CHECK_CONCURRENCY", 12, 1, 64),
    maxConcurrency: numberFromEnv("MAX_CHECK_CONCURRENCY", 24, 1, 64),
    perHostConcurrency: numberFromEnv("PER_HOST_CONCURRENCY", 4, 1, 16),
    connectTimeoutMs: numberFromEnv("CONNECT_TIMEOUT_MS", 2500, 250, 30000),
    headersTimeoutMs: numberFromEnv("HEADERS_TIMEOUT_MS", 5000, 500, 60000),
    readTimeoutMs: numberFromEnv("READ_TIMEOUT_MS", 2500, 250, 60000),
    totalTimeoutMs: numberFromEnv("CHECK_TIMEOUT_MS", 9000, 1000, 120000),
    tlsTimeoutMs: numberFromEnv("TLS_TIMEOUT_MS", 3500, 500, 30000),
    dnsTimeoutMs: numberFromEnv("DNS_TIMEOUT_MS", 2000, 250, 15000),
    dnsCacheTtlMs: numberFromEnv("DNS_CACHE_TTL_MS", 60000, 1000, 600000),
    retries: numberFromEnv("CHECK_RETRIES", 2, 0, 5),
    retryBaseMs: numberFromEnv("RETRY_BASE_MS", 180, 25, 5000),
    maxRedirects: numberFromEnv("MAX_REDIRECTS", 6, 0, 20),
    maxResponseBytes: numberFromEnv("MAX_RESPONSE_BYTES", 262144, 1024, 5_242_880),
    slowThresholdMs: numberFromEnv("SLOW_THRESHOLD_MS", 2000, 100, 120000),
    cacheTtlMs: numberFromEnv("CACHE_TTL_MS", 120000, 0, 3_600_000),
    cacheMaxEntries: numberFromEnv("CACHE_MAX_ENTRIES", 5000, 10, 100000),
    connectionsPerOrigin: numberFromEnv("HTTP_CONNECTIONS_PER_ORIGIN", 8, 1, 32),
    runsPerMinute: numberFromEnv("RATE_LIMIT_PER_MINUTE", 20, 1, 10000),
    urlsPerMinute: numberFromEnv("URL_RATE_LIMIT_PER_MINUTE", 5000, 1, 100000),
    maxActiveJobs: numberFromEnv("MAX_ACTIVE_JOBS_PER_IP", 2, 1, 20),
    resultRetentionMs: numberFromEnv("RESULT_RETENTION_MS", 86_400_000, 60_000, 604_800_000)
  };
}
