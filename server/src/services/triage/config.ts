const MIN_TOKEN_BYTES = 32;

export interface TriageConfig {
  webhookToken: string;
  tokenId: string;
  companyId: string;
  secretaryAgentId: string | undefined;
  rateLimitRpm: number;
  rateLimitRph: number;
  rateLimitIpRpm: number;
  fallbackHumanIdDefault: string | undefined;
  ipAllowlist: string[] | undefined;
  googleChatWebhookSecretary: string | undefined;
  triageBoardProjectId: string | undefined;
}

export interface TriageConfigResult {
  enabled: boolean;
  config: TriageConfig | null;
  reason: string | null;
}

export function loadTriageConfig(): TriageConfigResult {
  const token = process.env.PAPERCLIP_WEBHOOK_TOKEN;
  if (!token) {
    return { enabled: false, config: null, reason: "PAPERCLIP_WEBHOOK_TOKEN is not set" };
  }
  if (Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES) {
    return {
      enabled: false,
      config: null,
      reason: `PAPERCLIP_WEBHOOK_TOKEN is shorter than ${MIN_TOKEN_BYTES} bytes`,
    };
  }

  const rateLimitRpm = Math.max(1, Number(process.env.PAPERCLIP_TRIAGE_RATE_LIMIT_RPM) || 60);
  const rateLimitRph = Math.max(1, Number(process.env.PAPERCLIP_TRIAGE_RATE_LIMIT_RPH) || 600);
  const rateLimitIpRpm = Math.max(1, Number(process.env.PAPERCLIP_TRIAGE_RATE_LIMIT_IP_RPM) || 30);

  const companyId = process.env.PAPERCLIP_TRIAGE_COMPANY_ID ?? process.env.PAPERCLIP_COMPANY_ID;
  if (!companyId) {
    return {
      enabled: false,
      config: null,
      reason: "PAPERCLIP_TRIAGE_COMPANY_ID (or PAPERCLIP_COMPANY_ID) is not set",
    };
  }

  const ipAllowlistRaw = process.env.PAPERCLIP_TRIAGE_IP_ALLOWLIST;
  const ipAllowlist = ipAllowlistRaw
    ? ipAllowlistRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    : undefined;

  // Derive a stable token_id from last-4 chars of the token (never log the full token)
  const tokenId = `tok_${token.slice(-4)}`;

  return {
    enabled: true,
    config: {
      webhookToken: token,
      tokenId,
      companyId,
      secretaryAgentId: process.env.PAPERCLIP_TRIAGE_SECRETARY_AGENT_ID,
      rateLimitRpm,
      rateLimitRph,
      rateLimitIpRpm,
      fallbackHumanIdDefault: process.env.PAPERCLIP_TRIAGE_FALLBACK_HUMAN_ID_DEFAULT,
      ipAllowlist,
      googleChatWebhookSecretary: process.env.GOOGLE_CHAT_WEBHOOK_SECRETARY,
      triageBoardProjectId: process.env.PAPERCLIP_TRIAGE_BOARD_PROJECT_ID,
    },
    reason: null,
  };
}
