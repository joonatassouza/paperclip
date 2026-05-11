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

const bodyAttachmentSchema = z.object({
  kind: z.string().min(1).max(64),
  uriOrHash: z.string().min(1).max(2048),
  sizeBytes: z.number().int().nonnegative().optional(),
});

const triageRequestBodySchema = z.object({
  source: z.string().min(1).max(128),
  externalId: z.string().min(1).max(256),
  receivedAt: z.string().datetime({ offset: true }),
  sender: z.object({
    externalUserId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    email: z.string().email().optional(),
    roleHint: z.string().max(128).optional(),
  }),
  channel: z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    kind: z.string().min(1).max(64),
  }),
  bodyText: z.string().max(MAX_BODY_TEXT_CHARS),
  bodyAttachments: z.array(bodyAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
  threadContext: z
    .object({
      threadId: z.string().max(256).optional(),
      priorMessageExternalIds: z.array(z.string().max(256)).max(64).optional(),
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

    // Parse and validate request body
    const parseResult = triageRequestBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(422).json({
        error: "validation_error",
        message: "Request body does not match expected schema",
        details: parseResult.error.flatten(),
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
        // Exact replay — return cached response
        logger.info({ correlationId }, "triage webhook: idempotency cache hit — replaying");
        let cached: unknown;
        try {
          cached = JSON.parse(idempotencyResult.cachedResponseJson);
        } catch {
          cached = { error: "cached_response_corrupted" };
        }
        res.status(200).json(cached);
        return;
      }
      // Same key, different payload — conflict
      res.status(409).json({
        error: "idempotency_conflict",
        message: "Idempotency-Key was used with a different payload within the dedup window",
      });
      return;
    }

    // Route the message
    const triageRequest = {
      source: body.source,
      externalId: body.externalId,
      receivedAt: body.receivedAt,
      sender: body.sender,
      channel: body.channel,
      bodyText: body.bodyText,
      bodyAttachments: body.bodyAttachments,
      threadContext: body.threadContext,
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
        bodyText: body.bodyText,
        senderDisplayName: body.sender.displayName,
        channelId: body.channel.id,
        channelKind: body.channel.kind,
        source: body.source,
        targetAgentId: routingResult.routeToAgentId,
        confidence: routingResult.confidence,
        rationale: routingResult.reason,
        venaIdsMatched: routingResult.matchedVenaIds,
        secretaryAgentId: config.secretaryAgentId ?? null,
        boardProjectId: config.triageBoardProjectId ?? null,
        existingThreadId: body.threadContext?.threadId ?? null,
      });
      triageIssueId = cardResult.issueId;
    } catch (err) {
      logger.error({ err, correlationId }, "triage webhook: failed to create triage card — continuing");
    }

    // Fire ambiguity fanout if routed to human
    if (routingResult.outcome === "routed_to_human") {
      void sendAmbiguityFanout(
        correlationId,
        body.sender.displayName,
        body.channel.kind,
        routingResult.reason,
        config.googleChatWebhookSecretary,
      );
    }

    // Persist audit row
    const senderHash = hashSender(body.sender.externalUserId);
    try {
      await writeTriageEvent(db, {
        correlationId,
        idempotencyKeyHash,
        payloadHash,
        tokenId,
        receivedAt: new Date(body.receivedAt),
        source: body.source,
        channelId: body.channel.id,
        channelKind: body.channel.kind,
        senderExternalUserIdHash: senderHash,
        bodyLength: body.bodyText.length,
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

    const responseBody = {
      correlationId,
      outcome: routingResult.outcome,
      routeToKind: routingResult.routeToKind,
      routeToAgentId: routingResult.routeToAgentId,
      routeToHumanUserId: routingResult.routeToHumanUserId,
      confidence: routingResult.confidence,
      matchedVenaIds: routingResult.matchedVenaIds,
      triageIssueId,
      reason: routingResult.reason,
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
