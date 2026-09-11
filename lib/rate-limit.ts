type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const entries = new Map<string, RateLimitEntry>();

export function consumeRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const current = entries.get(key);
  const entry = current && current.resetAt > now
    ? current
    : { count: 0, resetAt: now + windowMs };

  entry.count += 1;
  entries.set(key, entry);

  if (entries.size > 10_000) {
    for (const [entryKey, value] of entries) {
      if (value.resetAt <= now) entries.delete(entryKey);
    }
  }

  return {
    allowed: entry.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

export function resetRateLimit(key: string) {
  entries.delete(key);
}

export function requestClientAddress(req: Request) {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 128);
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
    return (hops.at(-1) || "unknown").slice(0, 128);
  }
  return "unknown";
}
