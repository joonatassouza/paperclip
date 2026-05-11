import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { runClassifier, type AgentRosterEntry } from "./classifier.js";
import type { TriageConfig } from "./config.js";

const VENA_ID_REGEX = /\bVENA-\d+\b/gi;
const CONFIDENCE_THRESHOLD = 0.7;

export type ClassificationOutcome =
  | "routed_to_agent"
  | "routed_to_human"
  | "created_triage_card"
  | "vena_id_routed";

export interface RoutingResult {
  outcome: ClassificationOutcome;
  confidence: number | null;
  matchedVenaIds: string[] | null;
  reason: string;
  routeToKind: "agent" | "human_user" | "triage_card";
  routeToAgentId: string | null;
  routeToHumanUserId: string | null;
}

export interface TriageRequest {
  source: string;
  externalId: string;
  receivedAt: string;
  sender: {
    externalUserId: string;
    displayName: string;
    email?: string;
    roleHint?: string;
  };
  channel: {
    id: string;
    name: string;
    kind: string;
  };
  bodyText: string;
  bodyAttachments?: Array<{ kind: string; uriOrHash: string; sizeBytes?: number }>;
  threadContext?: {
    threadId?: string;
    priorMessageExternalIds?: string[];
  };
}

export function hashSender(externalUserId: string): string {
  return createHash("sha256").update(externalUserId).digest("hex");
}

function extractVenaIds(text: string): string[] {
  const matches = text.match(VENA_ID_REGEX) ?? [];
  const dedupedUpper = Array.from(new Set(matches.map((m) => m.toUpperCase())));
  return dedupedUpper;
}

async function loadAgentRoster(db: Db, companyId: string): Promise<AgentRosterEntry[]> {
  const rows = await db
    .select({
      id: agents.id,
      role: agents.role,
      capabilities: agents.capabilities,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  return rows.map((row) => ({
    agent_id: row.id,
    role: row.role,
    one_line_scope: (row.capabilities ?? "").slice(0, 120),
  }));
}

async function findCtoAgentId(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .then((all) => all.filter((a) => a.id));

  // Look for CTO role
  const ctoRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const cto = ctoRows.find((a) => (a as { id: string }).id);
  return cto?.id ?? null;
}

export async function route(
  db: Db,
  companyId: string,
  request: TriageRequest,
  config: TriageConfig,
): Promise<RoutingResult> {
  // Step 3: VENA-ID regex — short-circuits classifier
  const venaIds = extractVenaIds(request.bodyText);
  if (venaIds.length > 0) {
    const ctoAgentId = await findCtoAgentIdByRole(db, companyId);
    logger.info(
      { venaIds, correlationId: request.externalId },
      "triage router: VENA-ID match — routing to CTO",
    );
    return {
      outcome: "vena_id_routed",
      confidence: 1.0,
      matchedVenaIds: venaIds,
      reason: `Matched VENA IDs: ${venaIds.join(", ")}`,
      routeToKind: "agent",
      routeToAgentId: ctoAgentId,
      routeToHumanUserId: null,
    };
  }

  // Step 4: Classifier call
  const roster = await loadAgentRoster(db, companyId);
  const classifierResult = await runClassifier({
    body_text: request.bodyText,
    sender_display_name: request.sender.displayName,
    sender_role_hint: request.sender.roleHint,
    channel_kind: request.channel.kind,
    agent_roster: roster,
  });

  if (!classifierResult.success) {
    logger.warn(
      { error: classifierResult.error, externalId: request.externalId },
      "triage router: classifier failed — human fallback",
    );
    const fallbackHumanId = getFallbackHumanId(config, request.channel.kind);
    return {
      outcome: "routed_to_human",
      confidence: null,
      matchedVenaIds: null,
      reason: `Classifier failed: ${classifierResult.error}`,
      routeToKind: "human_user",
      routeToAgentId: null,
      routeToHumanUserId: fallbackHumanId,
    };
  }

  const output = classifierResult.output;

  // Step 5: Confidence gate
  if (
    output.confidence >= CONFIDENCE_THRESHOLD
    && output.target.kind === "agent"
    && output.target.agent_id
  ) {
    return {
      outcome: "routed_to_agent",
      confidence: output.confidence,
      matchedVenaIds: null,
      reason: output.rationale,
      routeToKind: "agent",
      routeToAgentId: output.target.agent_id,
      routeToHumanUserId: null,
    };
  }

  // Step 6: Ambiguity fallback
  const fallbackHumanId = getFallbackHumanId(config, request.channel.kind);
  return {
    outcome: "routed_to_human",
    confidence: output.confidence,
    matchedVenaIds: null,
    reason: output.rationale,
    routeToKind: "human_user",
    routeToAgentId: null,
    routeToHumanUserId: fallbackHumanId,
  };
}

async function findCtoAgentIdByRole(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  return rows.find((r) => r.role === "cto")?.id ?? rows[0]?.id ?? null;
}

function getFallbackHumanId(config: TriageConfig, channelKind: string): string | null {
  const channelKey = `PAPERCLIP_TRIAGE_FALLBACK_HUMAN_ID_${channelKind.toUpperCase()}`;
  const channelOverride = process.env[channelKey];
  return channelOverride ?? config.fallbackHumanIdDefault ?? null;
}
