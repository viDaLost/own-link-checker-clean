const buckets = new Map();
const activeJobs = new Map();

export function getClientIp(req) {
  return (
    req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers?.["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

export function consumeRateLimit(ip, config, urlCount = 1) {
  const now = Date.now();
  if (buckets.size > 10000) {
    for (const [key, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(key);
    }
  }
  const current = buckets.get(ip);
  const bucket = !current || current.resetAt <= now
    ? { runs: 0, urls: 0, resetAt: now + 60_000 }
    : current;

  bucket.runs += 1;
  bucket.urls += Math.max(1, urlCount);
  buckets.set(ip, bucket);

  return {
    allowed: bucket.runs <= config.runsPerMinute && bucket.urls <= config.urlsPerMinute,
    remainingRuns: Math.max(0, config.runsPerMinute - bucket.runs),
    remainingUrls: Math.max(0, config.urlsPerMinute - bucket.urls),
    resetAt: bucket.resetAt
  };
}

export function acquireJobSlot(ip, config) {
  const active = activeJobs.get(ip) || 0;
  if (active >= config.maxActiveJobs) return false;
  activeJobs.set(ip, active + 1);
  return true;
}

export function releaseJobSlot(ip) {
  const active = activeJobs.get(ip) || 0;
  if (active <= 1) activeJobs.delete(ip);
  else activeJobs.set(ip, active - 1);
}

export function clearRateLimits() {
  buckets.clear();
  activeJobs.clear();
}
