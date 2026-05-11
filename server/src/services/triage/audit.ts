import type { Db } from "@paperclipai/db";
import { triageEvents } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

export interface TriageAuditRow {
  correlationId: string;
  idempotencyKeyHash: string;
  payloadHash: string;
  tokenId: string;
  receivedAt: Date;
  source: string;
  channelId: string;
  channelKind: string;
  senderExternalUserIdHash: string;
  bodyLength: number;
  venaIdsMatched: string[] | null;
  classificationOutcome: string;
  confidence: string | null;
  routeKind: string;
  routeTargetId: string | null;
  triageIssueId: string | null;
  cachedResponseJson: string | null;
}

export async function writeTriageEvent(
  db: Db,
  row: TriageAuditRow,
): Promise<string> {
  const [inserted] = await db
    .insert(triageEvents)
    .values({
      correlationId: row.correlationId,
      idempotencyKeyHash: row.idempotencyKeyHash,
      payloadHash: row.payloadHash,
      tokenId: row.tokenId,
      receivedAt: row.receivedAt,
      source: row.source,
      channelId: row.channelId,
      channelKind: row.channelKind,
      senderExternalUserIdHash: row.senderExternalUserIdHash,
      bodyLength: row.bodyLength,
      venaIdsMatched: row.venaIdsMatched ?? undefined,
      classificationOutcome: row.classificationOutcome,
      confidence: row.confidence ?? undefined,
      routeKind: row.routeKind,
      routeTargetId: row.routeTargetId ?? undefined,
      triageIssueId: row.triageIssueId ?? undefined,
      cachedResponseJson: row.cachedResponseJson ?? undefined,
    })
    .onConflictDoNothing()
    .returning({ id: triageEvents.id });

  if (!inserted) {
    logger.warn({ correlationId: row.correlationId }, "triage audit: conflict on insert (idempotency dedup path)");
    return row.correlationId;
  }

  return inserted.id;
}

export async function updateTriageEventCachedResponse(
  db: Db,
  idempotencyKeyHash: string,
  payloadHash: string,
  cachedResponseJson: string,
): Promise<void> {
  const { eq, and } = await import("drizzle-orm");
  await db
    .update(triageEvents)
    .set({ cachedResponseJson })
    .where(
      and(
        eq(triageEvents.idempotencyKeyHash, idempotencyKeyHash),
        eq(triageEvents.payloadHash, payloadHash),
      ),
    );
}
