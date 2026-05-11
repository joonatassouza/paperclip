import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

const mockRunClassifier = vi.hoisted(() => vi.fn());

vi.mock("../services/triage/classifier.js", () => ({
  runClassifier: mockRunClassifier,
}));

// Minimal DB stub that returns an agent roster
function makeDb(agents: Array<{ id: string; role: string; capabilities?: string | null }>) {
  const select = vi.fn().mockReturnThis();
  const from = vi.fn().mockReturnThis();
  const where = vi.fn().mockResolvedValue(agents);
  return { select, from, where } as unknown as Db;
}

const baseRequest = {
  source: "google-chat",
  externalId: "ext-001",
  receivedAt: new Date().toISOString(),
  sender: {
    externalUserId: "u-abc",
    displayName: "Test Sender",
  },
  channel: {
    id: "space-1",
    name: "Team Space",
    kind: "google_chat",
  },
  bodyText: "Hello world",
};

const baseConfig = {
  webhookToken: "tok",
  tokenId: "tok_test",
  companyId: "company-1",
  secretaryAgentId: undefined,
  rateLimitRpm: 60,
  rateLimitRph: 600,
  rateLimitIpRpm: 30,
  fallbackHumanIdDefault: "human-fallback-id",
  ipAllowlist: undefined,
  googleChatWebhookSecretary: undefined,
  triageBoardProjectId: undefined,
};

describe("triage router", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("VENA-ID short-circuit", () => {
    it("returns vena_id_routed with confidence 1.0 when body contains VENA-ID", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([{ id: "agent-cto", role: "cto" }]);

      const result = await route(db, "company-1", {
        ...baseRequest,
        bodyText: "Please check VENA-123 and also VENA-456",
      }, baseConfig);

      expect(result.outcome).toBe("vena_id_routed");
      expect(result.confidence).toBe(1.0);
      expect(result.matchedVenaIds).toEqual(["VENA-123", "VENA-456"]);
      expect(result.routeToKind).toBe("agent");
      expect(result.routeToAgentId).toBe("agent-cto");
      expect(mockRunClassifier).not.toHaveBeenCalled();
    });

    it("deduplicates VENA IDs and normalises case", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([{ id: "agent-cto", role: "cto" }]);

      const result = await route(db, "company-1", {
        ...baseRequest,
        bodyText: "VENA-99 vena-99 VENA-99",
      }, baseConfig);

      expect(result.matchedVenaIds).toEqual(["VENA-99"]);
    });

    it("returns null routeToAgentId when no CTO role found — no fallback to preserve audit trail integrity", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([{ id: "agent-engineer", role: "engineer" }]);

      const result = await route(db, "company-1", {
        ...baseRequest,
        bodyText: "VENA-500 needs attention",
      }, baseConfig);

      expect(result.outcome).toBe("vena_id_routed");
      // Must be null — silently routing to a non-CTO agent corrupts the audit trail
      expect(result.routeToAgentId).toBeNull();
    });

    it("returns null routeToAgentId when roster is empty", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([]);

      const result = await route(db, "company-1", {
        ...baseRequest,
        bodyText: "VENA-200",
      }, baseConfig);

      expect(result.outcome).toBe("vena_id_routed");
      expect(result.routeToAgentId).toBeNull();
    });
  });

  describe("classifier routing", () => {
    it("returns routed_to_agent when confidence >= 0.7 and agent target provided", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([{ id: "agent-engineer", role: "engineer" }]);
      mockRunClassifier.mockResolvedValueOnce({
        success: true,
        output: {
          intent: "question",
          confidence: 0.9,
          target: { kind: "agent", agent_id: "agent-engineer" },
          rationale: "Engineering question",
        },
      });

      const result = await route(db, "company-1", baseRequest, baseConfig);

      expect(result.outcome).toBe("routed_to_agent");
      expect(result.confidence).toBe(0.9);
      expect(result.routeToAgentId).toBe("agent-engineer");
      expect(result.routeToHumanUserId).toBeNull();
    });

    it("returns routed_to_human when confidence < 0.7", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([{ id: "agent-cto", role: "cto" }]);
      mockRunClassifier.mockResolvedValueOnce({
        success: true,
        output: {
          intent: "ambiguous",
          confidence: 0.5,
          target: { kind: "unknown" },
          rationale: "Not sure",
        },
      });

      const result = await route(db, "company-1", baseRequest, baseConfig);

      expect(result.outcome).toBe("routed_to_human");
      expect(result.routeToKind).toBe("human_user");
      expect(result.routeToHumanUserId).toBe("human-fallback-id");
    });

    it("returns routed_to_human when confidence is exactly 0.7 with agent target", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([{ id: "agent-cto", role: "cto" }]);
      mockRunClassifier.mockResolvedValueOnce({
        success: true,
        output: {
          intent: "request",
          confidence: 0.7,
          target: { kind: "agent", agent_id: "agent-cto" },
          rationale: "Exactly at threshold",
        },
      });

      const result = await route(db, "company-1", baseRequest, baseConfig);

      expect(result.outcome).toBe("routed_to_agent");
      expect(result.confidence).toBe(0.7);
    });

    it("falls back to human when target.kind is not agent even with high confidence", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([]);
      mockRunClassifier.mockResolvedValueOnce({
        success: true,
        output: {
          intent: "other",
          confidence: 0.95,
          target: { kind: "human" },
          rationale: "Human needed",
        },
      });

      const result = await route(db, "company-1", baseRequest, baseConfig);

      expect(result.outcome).toBe("routed_to_human");
    });

    it("falls back to human when classifier returns success:false", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([]);
      mockRunClassifier.mockResolvedValueOnce({
        success: false,
        error: "classifier timeout",
      });

      const result = await route(db, "company-1", baseRequest, baseConfig);

      expect(result.outcome).toBe("routed_to_human");
      expect(result.confidence).toBeNull();
    });
  });

  describe("fallback human ID resolution", () => {
    it("uses per-channel env var if set", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([]);
      mockRunClassifier.mockResolvedValueOnce({ success: false, error: "fail" });
      process.env.PAPERCLIP_TRIAGE_FALLBACK_HUMAN_ID_GOOGLE_CHAT = "channel-specific-id";

      const result = await route(db, "company-1", {
        ...baseRequest,
        channel: { ...baseRequest.channel, kind: "google_chat" },
      }, { ...baseConfig, fallbackHumanIdDefault: "default-id" });

      expect(result.routeToHumanUserId).toBe("channel-specific-id");

      delete process.env.PAPERCLIP_TRIAGE_FALLBACK_HUMAN_ID_GOOGLE_CHAT;
    });

    it("returns null routeToHumanUserId when no fallback configured", async () => {
      const { route } = await import("../services/triage/router.js");
      const db = makeDb([]);
      mockRunClassifier.mockResolvedValueOnce({ success: false, error: "fail" });

      const result = await route(db, "company-1", baseRequest, {
        ...baseConfig,
        fallbackHumanIdDefault: undefined,
      });

      expect(result.routeToHumanUserId).toBeNull();
    });
  });
});
