interface Env {
  /** Required AI Gateway ID; configure as a Worker secret. */
  AI_GATEWAY_ID: string;
  /** JSON array of {ownerId, token, permissions?}; mcp:manage grants MCP administration. Keep in a Worker secret. */
  API_ACCOUNTS?: string;
  EMAIL_STATE_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CALENDAR_STATE_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
}
