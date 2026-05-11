import { createHash } from "node:crypto";
import { eq, and, gt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { triageEvents } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function hashIdempotencyKey(tokenId: string, rawKey: string): string {
  return createHash("sha256").update(`${tokenId}:${rawKey}`).digest("hex");
}

export function hashPayload(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export type IdempotencyCheckResult =
  | { hit: false }
  | { hit: true; samePayload: true; cachedResponseJson: string }
  | { hit: true; samePayload: false };

export async function checkIdempotency(
  db: Db,
  idempotencyKeyHash: string,
  payloadHash: string,
): Promise<IdempotencyCheckResult> {
  const cutoff = new Date(Date.now() - DEDUP_TTL_MS);
  let rows: Array<{ payloadHash: string; cachedResponseJson: string | null }>;
  try {
    rows = await db
      .select({
        payloadHash: triageEvents.payloadHash,
        cachedResponseJson: triageEvents.cachedResponseJson,
      })
      .from(triageEvents)
      .where(
        and(
          eq(triageEvents.idempotencyKeyHash, idempotencyKeyHash),
          gt(triageEvents.createdAt, cutoff),
        ),
      )
      .limit(1);
  } catch (err) {
    logger.error({ err, tag: "idempotency_store_unavailable" }, "triage: idempotency DB query failed");
    throw new IdempotencyStoreUnavailableError("DB query failed for idempotency check");
  }

  if (rows.length === 0) return { hit: false };

  const existing = rows[0];
  if (existing.payloadHash === payloadHash) {
    if (!existing.cachedResponseJson) {
      return { hit: false };
    }
    return { hit: true, samePayload: true, cachedResponseJson: existing.cachedResponseJson };
  }
  return { hit: true, samePayload: false };
}

export class IdempotencyStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyStoreUnavailableError";
  }
}
