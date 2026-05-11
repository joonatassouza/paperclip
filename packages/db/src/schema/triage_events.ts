import { pgTable, uuid, text, integer, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const triageEvents = pgTable(
  "triage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    correlationId: text("correlation_id").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    payloadHash: text("payload_hash").notNull(),
    tokenId: text("token_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    channelId: text("channel_id").notNull(),
    channelKind: text("channel_kind").notNull(),
    senderExternalUserIdHash: text("sender_external_user_id_hash").notNull(),
    bodyLength: integer("body_length").notNull(),
    venaIdsMatched: text("vena_ids_matched").array(),
    classificationOutcome: text("classification_outcome").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    routeKind: text("route_kind").notNull(),
    routeTargetId: text("route_target_id"),
    triageIssueId: text("triage_issue_id"),
    cachedResponseJson: text("cached_response_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    correlationIdIdx: index("triage_events_correlation_id_idx").on(table.correlationId),
    idempotencyIdx: uniqueIndex("triage_events_idempotency_uq").on(
      table.idempotencyKeyHash,
      table.payloadHash,
    ),
    createdAtIdx: index("triage_events_created_at_idx").on(table.createdAt),
    outcomeCreatedAtIdx: index("triage_events_outcome_created_at_idx").on(
      table.classificationOutcome,
      table.createdAt,
    ),
  }),
);
