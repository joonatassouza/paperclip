import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

// --- hoisted mocks ---

const mockCheckIdempotency = vi.hoisted(() => vi.fn());
const mockWriteTriageEvent = vi.hoisted(() => vi.fn());
const mockUpdateTriageEventCachedResponse = vi.hoisted(() => vi.fn());
const mockCreateOrUpdateTriageCard = vi.hoisted(() => vi.fn());
const mockSendAmbiguityFanout = vi.hoisted(() => vi.fn());
const mockRoute = vi.hoisted(() => vi.fn());
const mockLoadTriageConfig = vi.hoisted(() => vi.fn());

vi.mock("../services/triage/idempotency.js", () => ({
  hashIdempotencyKey: (tokenId: string, key: string) => `${tokenId}:${key}`,
  hashPayload: (body: unknown) => JSON.stringify(body).slice(0, 16),
  checkIdempotency: mockCheckIdempotency,
  IdempotencyStoreUnavailableError: class IdempotencyStoreUnavailableError extends Error {
    constructor(msg: string) { super(msg); this.name = "IdempotencyStoreUnavailableError"; }
  },
}));

vi.mock("../services/triage/audit.js", () => ({
  writeTriageEvent: mockWriteTriageEvent,
  updateTriageEventCachedResponse: mockUpdateTriageEventCachedResponse,
}));

vi.mock("../services/triage/notify.js", () => ({
  createOrUpdateTriageCard: mockCreateOrUpdateTriageCard,
  sendAmbiguityFanout: mockSendAmbiguityFanout,
}));

vi.mock("../services/triage/router.js", () => ({
  route: mockRoute,
  hashSender: (id: string) => `hash:${id}`,
}));

vi.mock("../services/triage/config.js", () => ({
  loadTriageConfig: mockLoadTriageConfig,
}));

// --- test helpers ---

const TEST_TOKEN = "test-webhook-token-32-bytes-long!!";

function validConfig() {
  return {
    enabled: true,
    config: {
      webhookToken: TEST_TOKEN,
      tokenId: "tok_ng!!",
      companyId: "company-1",
      secretaryAgentId: undefined,
      rateLimitRpm: 1000,
      rateLimitRph: 10000,
      rateLimitIpRpm: 1000,
      fallbackHumanIdDefault: "human-1",
      ipAllowlist: undefined,
      googleChatWebhookSecretary: undefined,
      triageBoardProjectId: undefined,
    },
    reason: null,
  };
}

function defaultRoutingResult() {
  return {
    outcome: "routed_to_agent" as const,
    confidence: 0.92,
    matchedVenaIds: null,
    reason: "Engineering question",
    routeToKind: "agent" as const,
    routeToAgentId: "agent-engineer",
    routeToHumanUserId: null,
  };
}

// § 3.3 — wire body uses snake_case
const validBody = {
  source: "google-chat",
  external_id: "ext-001",
  received_at: new Date().toISOString(),
  sender: { external_user_id: "u-abc", display_name: "Test Sender" },
  channel: { id: "space-1", name: "Team Space", kind: "google_chat" },
  body_text: "Please help me debug this issue",
};

async function createTestApp() {
  const { errorHandler } = await import("../middleware/index.js");
  const { chatTriageRoutes } = await import("../routes/webhooks/chat-triage.js");
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const router = chatTriageRoutes({} as Db);
  if (router) app.use("/api", router);
  app.use(errorHandler);
  return app;
}

// --- tests ---

describe("POST /api/webhooks/chat-triage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLoadTriageConfig.mockReturnValue(validConfig());
    mockCheckIdempotency.mockResolvedValue({ hit: false });
    mockRoute.mockResolvedValue(defaultRoutingResult());
    mockCreateOrUpdateTriageCard.mockResolvedValue({ issueId: "issue-triage-1", wasExisting: false });
    mockWriteTriageEvent.mockResolvedValue("event-id-1");
    mockUpdateTriageEventCachedResponse.mockResolvedValue(undefined);
    mockSendAmbiguityFanout.mockResolvedValue(undefined);
  });

  describe("happy path", () => {
    it("returns 200 with nested routing result for a valid request", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-001")
        .send(validBody);

      expect(res.status).toBe(200);
      // § 3.4 — nested response shape
      expect(res.body.classification.outcome).toBe("routed_to_agent");
      expect(res.body.correlation_id).toBeTruthy();
      expect(res.body.route_to.agent_id).toBe("agent-engineer");
      expect(res.body.triage_event_id).toBe("issue-triage-1");
      expect(res.body.idempotent_replay).toBe(false);
      expect(mockWriteTriageEvent).toHaveBeenCalledOnce();
      expect(mockUpdateTriageEventCachedResponse).toHaveBeenCalledOnce();
    });

    it("uses caller-supplied X-Correlation-Id if provided", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-002")
        .set("X-Correlation-Id", "my-corr-id-123")
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.correlation_id).toBe("my-corr-id-123");
    });

    it("fires ambiguity fanout when outcome is routed_to_human", async () => {
      mockRoute.mockResolvedValue({
        outcome: "routed_to_human",
        confidence: 0.4,
        matchedVenaIds: null,
        reason: "Ambiguous",
        routeToKind: "human_user",
        routeToAgentId: null,
        routeToHumanUserId: "human-1",
      });

      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-003")
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.classification.outcome).toBe("routed_to_human");
      // fanout is fire-and-forget; just ensure it was called
      await vi.waitFor(() => expect(mockSendAmbiguityFanout).toHaveBeenCalledOnce());
    });

    it("returns 200 even when triage card creation fails", async () => {
      mockCreateOrUpdateTriageCard.mockRejectedValue(new Error("DB error"));

      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-004")
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.triage_event_id).toBeNull();
    });
  });

  describe("input validation", () => {
    it("returns 401 for missing Authorization header", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-005")
        .send(validBody);

      expect(res.status).toBe(401);
    });

    it("returns 401 for wrong Bearer token", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", "Bearer wrong-token")
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-006")
        .send(validBody);

      expect(res.status).toBe(401);
    });

    it("returns 415 for non-JSON content-type", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "text/plain")
        .set("Idempotency-Key", "idem-007")
        .send("hello");

      expect(res.status).toBe(415);
    });

    it("returns 422 for missing Idempotency-Key header", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .send(validBody);

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("missing_idempotency_key");
    });

    it("returns 422 for missing required fields — no field-level detail leaked", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-008")
        .send({ source: "test" }); // missing required fields

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("validation_error");
      // § 3.5 — no field-level detail in 422 body
      expect(res.body.details).toBeUndefined();
    });

    it("returns 422 for body_text that exceeds 200k chars", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-009")
        .send({ ...validBody, body_text: "x".repeat(200_001) });

      expect(res.status).toBe(422);
    });

    it("rejects camelCase fields — wire contract is snake_case", async () => {
      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-sc")
        .send({
          source: "google-chat",
          externalId: "ext-001",
          receivedAt: new Date().toISOString(),
          sender: { externalUserId: "u-abc", displayName: "Test Sender" },
          channel: { id: "space-1", name: "Team Space", kind: "google_chat" },
          bodyText: "Hello",
        });

      expect(res.status).toBe(422);
    });
  });

  describe("idempotency", () => {
    it("returns cached response with idempotent_replay:true on exact replay", async () => {
      const cachedResponse = {
        correlation_id: "cached-corr",
        triage_event_id: "issue-cached",
        idempotent_replay: false,
        classification: { outcome: "routed_to_agent", confidence: 0.9, matched_vena_ids: null, reason: "ok" },
        route_to: { kind: "agent", agent_id: "agent-1", human_user_id: null },
      };
      mockCheckIdempotency.mockResolvedValue({
        hit: true,
        samePayload: true,
        cachedResponseJson: JSON.stringify(cachedResponse),
      });

      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-010")
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.correlation_id).toBe("cached-corr");
      expect(res.body.idempotent_replay).toBe(true);
      expect(mockRoute).not.toHaveBeenCalled();
    });

    it("returns 409 when same key used with different payload", async () => {
      mockCheckIdempotency.mockResolvedValue({ hit: true, samePayload: false });

      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-011")
        .send(validBody);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("idempotency_conflict");
    });

    it("returns 500 when idempotency store is unavailable", async () => {
      const { IdempotencyStoreUnavailableError } = await import("../services/triage/idempotency.js");
      mockCheckIdempotency.mockRejectedValue(new IdempotencyStoreUnavailableError("DB down"));

      const app = await createTestApp();
      const res = await request(app)
        .post("/api/webhooks/chat-triage")
        .set("Authorization", `Bearer ${TEST_TOKEN}`)
        .set("Content-Type", "application/json")
        .set("Idempotency-Key", "idem-012")
        .send(validBody);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("idempotency_store_unavailable");
    });
  });

  describe("webhook disabled", () => {
    it("does not register route when PAPERCLIP_WEBHOOK_TOKEN is missing", async () => {
      mockLoadTriageConfig.mockReturnValue({
        enabled: false,
        config: null,
        reason: "PAPERCLIP_WEBHOOK_TOKEN is not set",
      });

      const { errorHandler } = await import("../middleware/index.js");
      const { chatTriageRoutes } = await import("../routes/webhooks/chat-triage.js");
      const app = express();
      app.use(express.json());
      const router = chatTriageRoutes({} as Db);
      // router is null — route never registered
      expect(router).toBeNull();
    });
  });
});
