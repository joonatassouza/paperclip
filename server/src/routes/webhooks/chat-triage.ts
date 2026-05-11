import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { createWebhookAuthMiddleware } from "../../middleware/webhook-auth.js";
import { loadTriageConfig } from "../../services/triage/config.js";
import {
  hashIdempotencyKey,
  hashPayload,
  checkIdempotency,
  IdempotencyStoreUnavailableError,
} from "../../services/triage/idempotency.js";
import { hashSender, route } from "../../services/triage/router.js";
import { writeTriageEvent, updateTriageEventCachedResponse } from "../../services/triage/audit.js";
import { createOrUpdateTriageCard, sendAmbiguityFanout } from "../../services/triage/notify.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_BODY_TEXT_CHARS = 200_000;
const MAX_ATTACHMENTS = 16;

// § 3.3 — all wire-level fields are snake_case
const bodyAttachmentSchema = z.object({
  kind: z.string().min(1).max(64),
  uri_or_hash: z.string().min(1).max(2048),
  size_bytes: z.number().int().nonnegative().optional(),
});

const triageRequestBodySchema = z.object({
  source: z.string().min(1).max(128),
  external_id: z.string().min(1).max(256),
  received_at: z.string().datetime({ offset: true }),
  sender: z.object({
    external_user_id: z.string().min(1).max(256),
    display_name: z.string().min(1).max(256),
    email: z.string().email().optional(),
    role_hint: z.string().max(128).optional(),
  }),
  channel: z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    kind: z.string().min(1).max(64),
  }),
  body_text: z.string().max(MAX_BODY_TEXT_CHARS),
  body_attachments: z.array(bodyAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
  thread_context: z
    .object({
      thread_id: z.string().max(256).optional(),
      prior_message_external_ids: z.array(z.string().max(256)).max(64).optional(),
    })
    .optional(),
});

export function chatTriageRoutes(db: Db) {
  const configResult = loadTriageConfig();
  if (!configResult.enabled || !configResult.config) {
    logger.warn(
      { reason: configResult.reason },
      "triage webhook: disabled — skipping route registration",
    );
    return null;
  }

  const config = configResult.config;
  const authMiddleware = createWebhookAuthMiddleware({
    webhookToken: config.webhookToken,
    tokenId: config.tokenId,
    rateLimitRpm: config.rateLimitRpm,
    rateLimitRph: config.rateLimitRph,
    rateLimitIpRpm: config.rateLimitIpRpm,
    ipAllowlist: config.ipAllowlist,
  });

  const router = Router();

  router.post("/webhooks/chat-triage", authMiddleware, async (req, res) => {
    // Content-Type must be application/json
    const contentType = req.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      res.status(415).json({ error: "unsupported_media_type", message: "Content-Type must be application/json" });
      return;
    }

    // Content-Length guard (express.json already limits, but re-check for explicit 413)
    const contentLength = parseInt(req.get("content-length") ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      res.status(413).json({ error: "payload_too_large", message: `Body must not exceed ${MAX_BODY_BYTES} bytes` });
      return;
    }

    // Correlation ID — accept caller-supplied or generate
    const correlationId: string =
      (req.headers["x-correlation-id"] as string | undefined)?.slice(0, 128)
      || randomUUID();

    // Idempotency-Key is required
    const rawIdempotencyKey = req.headers["idempotency-key"] as string | undefined;
    if (!rawIdempotencyKey) {
      res.status(422).json({ error: "missing_idempotency_key", message: "Idempotency-Key header is required" });
      return;
    }

    // § 3.5 — parse and validate; never leak field-level error detail
    const parseResult = triageRequestBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(422).json({
        error: "validation_error",
        message: "Request body does not match expected schema",
      });
      return;
    }
    const body = parseResult.data;

    const tokenId = (req as typeof req & { triageTokenId?: string }).triageTokenId ?? config.tokenId;
    const idempotencyKeyHash = hashIdempotencyKey(tokenId, rawIdempotencyKey);
    const payloadHash = hashPayload(body);

    // Idempotency check — fail-closed on DB error
    let idempotencyResult: Awaited<ReturnType<typeof checkIdempotency>>;
    try {
      idempotencyResult = await checkIdempotency(db, idempotencyKeyHash, payloadHash);
    } catch (err) {
      if (err instanceof IdempotencyStoreUnavailableError) {
        logger.error(
          { correlationId, err, tag: "idempotency_store_unavailable" },
          "triage webhook: idempotency store unavailable — rejecting",
        );
        res.status(500).json({ error: "idempotency_store_unavailable" });
        return;
      }
      throw err;
    }

    if (idempotencyResult.hit) {
      if (idempotencyResult.samePayload && idempotencyResult.cachedResponseJson) {
        // Exact replay — return cached response with idempotent_replay flag overridden to true
        logger.info({ correlationId }, "triage webhook: idempotency cache hit — replaying");
        let cached: Record<string, unknown>;
        try {
          cached = JSON.parse(idempotencyResult.cachedResponseJson) as Record<string, unknown>;
        } catch {
          cached = { error: "cached_response_corrupted" };
        }
        res.status(200).json({ ...cached, idempotent_replay: true });
        return;
      }
      // Same key, different payload — conflict
      res.status(409).json({
        error: "idempotency_conflict",
        message: "Idempotency-Key was used with a different payload within the dedup window",
      });
      return;
    }

    // Map snake_case wire body to internal camelCase TriageRequest
    const triageRequest = {
      source: body.source,
      externalId: body.external_id,
      receivedAt: body.received_at,
      sender: {
        externalUserId: body.sender.external_user_id,
        displayName: body.sender.display_name,
        email: body.sender.email,
        roleHint: body.sender.role_hint,
      },
      channel: body.channel,
      bodyText: body.body_text,
      bodyAttachments: body.body_attachments?.map((a) => ({
        kind: a.kind,
        uriOrHash: a.uri_or_hash,
        sizeBytes: a.size_bytes,
      })),
      threadContext: body.thread_context
        ? {
            threadId: body.thread_context.thread_id,
            priorMessageExternalIds: body.thread_context.prior_message_external_ids,
          }
        : undefined,
    };

    const routingResult = await route(db, config.companyId, triageRequest, config);

    logger.info(
      {
        correlationId,
        outcome: routingResult.outcome,
        routeToKind: routingResult.routeToKind,
        confidence: routingResult.confidence,
      },
      "triage webhook: routed",
    );

    // Create or update triage card on Board (always — audit trail)
    let triageIssueId: string | null = null;
    try {
      const cardResult = await createOrUpdateTriageCard(db, {
        companyId: config.companyId,
        correlationId,
        bodyText: body.body_text,
        senderDisplayName: body.sender.display_name,
        channelId: body.channel.id,
        channelKind: body.channel.kind,
        source: body.source,
        targetAgentId: routingResult.routeToAgentId,
        confidence: routingResult.confidence,
        rationale: routingResult.reason,
        venaIdsMatched: routingResult.matchedVenaIds,
        secretaryAgentId: config.secretaryAgentId ?? null,
        boardProjectId: config.triageBoardProjectId ?? null,
        existingThreadId: body.thread_context?.thread_id ?? null,
      });
      triageIssueId = cardResult.issueId;
    } catch (err) {
      logger.error({ err, correlationId }, "triage webhook: failed to create triage card — continuing");
    }

    // § 6 identity erasure — fanout carries no PII; channelKind is structural metadata only
    if (routingResult.outcome === "routed_to_human") {
      void sendAmbiguityFanout(
        correlationId,
        body.channel.kind,
        routingResult.reason,
        config.googleChatWebhookSecretary,
      );
    }

    // Persist audit row
    const senderHash = hashSender(body.sender.external_user_id);
    try {
      await writeTriageEvent(db, {
        correlationId,
        idempotencyKeyHash,
        payloadHash,
        tokenId,
        receivedAt: new Date(body.received_at),
        source: body.source,
        channelId: body.channel.id,
        channelKind: body.channel.kind,
        senderExternalUserIdHash: senderHash,
        bodyLength: body.body_text.length,
        venaIdsMatched: routingResult.matchedVenaIds,
        classificationOutcome: routingResult.outcome,
        confidence: routingResult.confidence !== null ? String(routingResult.confidence) : null,
        routeKind: routingResult.routeToKind,
        routeTargetId: routingResult.routeToAgentId ?? routingResult.routeToHumanUserId,
        triageIssueId,
        cachedResponseJson: null,
      });
    } catch (err) {
      logger.error({ err, correlationId }, "triage webhook: failed to write triage event — continuing");
    }

    // § 3.4 — nested classification / route_to shape, all snake_case
    const responseBody = {
      correlation_id: correlationId,
      triage_event_id: triageIssueId,
      idempotent_replay: false,
      classification: {
        outcome: routingResult.outcome,
        confidence: routingResult.confidence,
        matched_vena_ids: routingResult.matchedVenaIds,
        reason: routingResult.reason,
      },
      route_to: {
        kind: routingResult.routeToKind,
        agent_id: routingResult.routeToAgentId,
        human_user_id: routingResult.routeToHumanUserId,
      },
    };

    // Cache the response for idempotency replay
    try {
      await updateTriageEventCachedResponse(
        db,
        idempotencyKeyHash,
        payloadHash,
        JSON.stringify(responseBody),
      );
    } catch (err) {
      logger.warn({ err, correlationId }, "triage webhook: failed to cache response — idempotency replay may miss");
    }

    res.status(200).json(responseBody);
  });

  return router;
}
