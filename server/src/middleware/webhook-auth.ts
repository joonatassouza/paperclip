import { timingSafeEqual, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

interface RateLimitWindow {
  count: number;
  windowStart: number;
}

function makeRateLimiter(maxPerMinute: number, maxPerHour: number) {
  const minuteWindows = new Map<string, RateLimitWindow>();
  const hourWindows = new Map<string, RateLimitWindow>();

  return {
    check(key: string): { allowed: boolean; retryAfterSeconds: number } {
      const now = Date.now();
      const minuteMs = 60_000;
      const hourMs = 3_600_000;

      const minW = minuteWindows.get(key) ?? { count: 0, windowStart: now };
      if (now - minW.windowStart >= minuteMs) {
        minW.count = 0;
        minW.windowStart = now;
      }

      const hrW = hourWindows.get(key) ?? { count: 0, windowStart: now };
      if (now - hrW.windowStart >= hourMs) {
        hrW.count = 0;
        hrW.windowStart = now;
      }

      if (minW.count >= maxPerMinute) {
        const retryAfterSeconds = Math.ceil((minuteMs - (now - minW.windowStart)) / 1000);
        minuteWindows.set(key, minW);
        hourWindows.set(key, hrW);
        return { allowed: false, retryAfterSeconds };
      }
      if (hrW.count >= maxPerHour) {
        const retryAfterSeconds = Math.ceil((hourMs - (now - hrW.windowStart)) / 1000);
        minuteWindows.set(key, minW);
        hourWindows.set(key, hrW);
        return { allowed: false, retryAfterSeconds };
      }

      minW.count += 1;
      hrW.count += 1;
      minuteWindows.set(key, minW);
      hourWindows.set(key, hrW);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

export interface WebhookAuthConfig {
  webhookToken: string;
  tokenId: string;
  rateLimitRpm: number;
  rateLimitRph: number;
  rateLimitIpRpm: number;
  ipAllowlist?: string[];
}

export function createWebhookAuthMiddleware(config: WebhookAuthConfig) {
  const tokenBuffer = Buffer.from(config.webhookToken, "utf8");
  const tokenRateLimiter = makeRateLimiter(config.rateLimitRpm, config.rateLimitRph);
  const ipRateLimiter = makeRateLimiter(config.rateLimitIpRpm, Number.MAX_SAFE_INTEGER);

  return function webhookAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    // IP allowlist check (optional defense-in-depth)
    if (config.ipAllowlist && config.ipAllowlist.length > 0) {
      const clientIp = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
        ?? req.socket.remoteAddress
        ?? "";
      if (!config.ipAllowlist.includes(clientIp)) {
        logger.warn({ clientIp }, "triage webhook: IP not in allowlist");
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    // Per-IP pre-auth rate limit (before token validation)
    const clientIp = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? "unknown";
    const ipCheck = ipRateLimiter.check(`ip:${clientIp}`);
    if (!ipCheck.allowed) {
      res.status(429).set("Retry-After", String(ipCheck.retryAfterSeconds)).json({
        error: "rate_limited",
        retry_after_seconds: ipCheck.retryAfterSeconds,
      });
      return;
    }

    // Header-smuggling defense: reject multiple Authorization headers
    const rawAuthHeaders = req.headers.authorization;
    // Node's http parser collapses duplicate headers into comma-joined strings
    // Express also populates req.headers with strings; duplicates become "a, b"
    // Check for the raw header array via IncomingMessage internals
    const rawHeaders = (req as unknown as { rawHeaders?: string[] }).rawHeaders ?? [];
    let authHeaderCount = 0;
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i]?.toLowerCase() === "authorization") authHeaderCount++;
    }
    if (authHeaderCount > 1) {
      logger.warn({ correlationId: req.headers["x-correlation-id"] }, "triage webhook: multiple Authorization headers");
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // Bearer token presence
    if (!rawAuthHeaders || !rawAuthHeaders.toLowerCase().startsWith("bearer ")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const suppliedToken = rawAuthHeaders.slice("bearer ".length);

    // Constant-time compare
    let isValid = false;
    try {
      const suppliedBuffer = Buffer.alloc(tokenBuffer.length);
      const suppliedTokenBuffer = Buffer.from(suppliedToken, "utf8");
      // If lengths differ, fill with zeros to still run constant-time compare
      suppliedTokenBuffer.copy(suppliedBuffer, 0, 0, Math.min(suppliedTokenBuffer.length, tokenBuffer.length));
      isValid = suppliedTokenBuffer.length === tokenBuffer.length
        && timingSafeEqual(tokenBuffer, suppliedBuffer);
    } catch {
      isValid = false;
    }

    if (!isValid) {
      logger.warn(
        {
          correlationId: req.headers["x-correlation-id"],
          tokenSuffix: suppliedToken.slice(-4),
        },
        "triage webhook: invalid token",
      );
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // Per-token rate limit (after auth success)
    const tokenCheck = tokenRateLimiter.check(`token:${config.tokenId}`);
    if (!tokenCheck.allowed) {
      res.status(429).set("Retry-After", String(tokenCheck.retryAfterSeconds)).json({
        error: "rate_limited",
        retry_after_seconds: tokenCheck.retryAfterSeconds,
      });
      return;
    }

    // Attach tokenId for downstream services
    (req as Request & { triageTokenId?: string }).triageTokenId = config.tokenId;
    next();
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
