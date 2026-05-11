import type { Db } from "@paperclipai/db";
import { issues, issueComments } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";

const MAX_TITLE_LENGTH = 80;

export interface TriageCardInput {
  companyId: string;
  correlationId: string;
  bodyText: string;
  senderDisplayName: string;
  channelId: string;
  channelKind: string;
  source: string;
  targetAgentId: string | null;
  confidence: number | null;
  rationale: string | null;
  venaIdsMatched: string[] | null;
  secretaryAgentId: string | null;
  boardProjectId: string | null;
  existingThreadId: string | null;
}

export interface TriageCardResult {
  issueId: string;
  wasExisting: boolean;
}

export async function createOrUpdateTriageCard(
  db: Db,
  input: TriageCardInput,
): Promise<TriageCardResult> {
  // If there's an existing thread mapping, try to find its triage issue
  if (input.existingThreadId) {
    const existing = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, "triage"),
          eq(issues.originId, input.existingThreadId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const issueId = existing[0].id;
      // Add a comment to the existing triage card
      const commentBody = buildMentionBody({
        correlationId: input.correlationId,
        bodyText: input.bodyText,
        senderDisplayName: input.senderDisplayName,
        targetAgentId: input.targetAgentId,
        confidence: input.confidence,
        rationale: input.rationale,
      });

      await db.insert(issueComments).values({
        issueId,
        companyId: input.companyId,
        body: commentBody,
        authorAgentId: input.secretaryAgentId ?? undefined,
        authorType: input.secretaryAgentId ? "agent" : undefined,
      });

      return { issueId, wasExisting: true };
    }
  }

  // Create new triage card
  const titleRaw = input.bodyText.replace(/\n/g, " ").slice(0, MAX_TITLE_LENGTH);
  const title = titleRaw.length < input.bodyText.length ? `${titleRaw}…` : titleRaw;

  const description = buildMentionBody({
    correlationId: input.correlationId,
    bodyText: input.bodyText,
    senderDisplayName: input.senderDisplayName,
    targetAgentId: input.targetAgentId,
    confidence: input.confidence,
    rationale: input.rationale,
  });

  const newIssue = await issueService(db).create(
    input.companyId,
    {
      title,
      description,
      status: "backlog",
      priority: "medium",
      originKind: "triage",
      originId: input.existingThreadId ?? input.correlationId,
      projectId: input.boardProjectId ?? undefined,
      createdByAgentId: input.secretaryAgentId ?? undefined,
      assigneeAgentId: input.targetAgentId ?? undefined,
    },
  );

  return { issueId: newIssue.id, wasExisting: false };
}

function buildMentionBody(opts: {
  correlationId: string;
  bodyText: string;
  senderDisplayName: string;
  targetAgentId: string | null;
  confidence: number | null;
  rationale: string | null;
}): string {
  const lines: string[] = [
    `**Correlation ID:** ${opts.correlationId}`,
    `**Sender:** ${opts.senderDisplayName}`,
    opts.targetAgentId ? `**Routed to agent:** ${opts.targetAgentId}` : "**Routing:** ambiguity fallback to human",
    opts.confidence !== null ? `**Confidence:** ${opts.confidence.toFixed(2)}` : null,
    opts.rationale ? `**Rationale:** ${opts.rationale}` : null,
    ``,
    `---`,
    ``,
    opts.bodyText,
  ]
    .filter((line): line is string => line !== null);
  return lines.join("\n");
}

export async function sendAmbiguityFanout(
  correlationId: string,
  senderDisplayName: string,
  channelKind: string,
  rationale: string | null,
  webhookUrl: string | undefined,
): Promise<void> {
  if (!webhookUrl) {
    logger.warn({ correlationId }, "triage notify: no ambiguity fanout webhook configured");
    return;
  }

  const msg = [
    `*Triage ambiguity — action required*`,
    ``,
    `- *What:* Inbound message from ${senderDisplayName} via ${channelKind} could not be confidently routed`,
    `- *Why:* ${rationale ?? "Classifier confidence below threshold or unknown target"}`,
    `- *Who unblocks:* Designated human reviewer — please check Board Triage for correlation ID ${correlationId}`,
    `- *Cross-channel:* Correlation ID ${correlationId} in triage_events`,
  ].join("\n");

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, correlationId }, "triage notify: GC ambiguity webhook non-204");
    }
  } catch (err) {
    logger.warn({ err, correlationId }, "triage notify: GC ambiguity webhook fetch failed");
  }
}
