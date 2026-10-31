import { getAgentByName } from "agents";
import { verifyCalendarState } from "./calendar";
import { verifyEmailState } from "./email";
import {
  authorizedMessage,
  parseAllowedUserIds,
  telegramUpdateSchema
} from "./telegram";
import { apiAccounts, ownerIdSchema } from "./identity";
import { handleApi } from "./http-api";

function authorizedOwner(env: Env, ownerId: string) {
  if (apiAccounts(env)?.some((account) => account.ownerId === ownerId))
    return true;
  const allowed = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);
  return (
    ownerId.startsWith("telegram:") && Boolean(allowed?.has(ownerId.slice(9)))
  );
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return handleApi(request, env);
    if (path === "/health" && request.method === "GET")
      return new Response("ok");
    const mcpCallback = /^\/connectors\/mcp\/([^/]+)\/callback$/.exec(path);
    if (mcpCallback) {
      const headers = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff"
      };
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { ...headers, allow: "GET" }
        });
      try {
        const ownerId = ownerIdSchema.parse(decodeURIComponent(mcpCallback[1]));
        if (
          !apiAccounts(env)?.some(
            (account) =>
              account.ownerId === ownerId &&
              account.permissions.includes("mcp:manage")
          )
        )
          return new Response("Unauthorized", { status: 401, headers });
        const url = new URL(request.url);
        if (url.search.length > 16 * 1024) throw new Error();
        const agent = await getAgentByName(env.ChatAgent, ownerId);
        // The SDK verifies the stored callback URL, one-time state and PKCE.
        const connected = await agent.completeMcpAuthorization(url.href);
        return new Response(
          connected
            ? "MCP server connected. You can close this page and return to your agent."
            : "MCP authorization failed or expired. Check the connection through the REST API.",
          { status: connected ? 200 : 400, headers }
        );
      } catch {
        return new Response(
          "MCP authorization failed or expired. Check the connection through the REST API.",
          { status: 400, headers }
        );
      }
    }
    if (path === "/connectors/gmail/callback" && request.method === "GET") {
      const headers = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff"
      };
      try {
        const url = new URL(request.url);
        const state = await verifyEmailState(
          env,
          url.searchParams.get("state") ?? ""
        );
        const ownerId = state.ownerId;
        if (!authorizedOwner(env, ownerId))
          return new Response("Unauthorized", { status: 401, headers });
        if (url.searchParams.has("error"))
          return new Response(
            "Gmail connection declined. Return to your agent.",
            { status: 400, headers }
          );
        const code = url.searchParams.get("code");
        if (!code || code.length > 4096) throw new Error("Missing code");
        const agent = await getAgentByName(env.ChatAgent, ownerId);
        await agent.completeEmailConnection(state.nonce, code);
        return new Response(
          "Gmail connected with read-only access. Return to your agent and ask about your email. The agent cannot send or change mail.",
          { headers }
        );
      } catch {
        return new Response(
          "Gmail connection failed or expired. Use /email connect to try again.",
          { status: 400, headers }
        );
      }
    }
    if (path === "/connectors/google/callback" && request.method === "GET") {
      try {
        const url = new URL(request.url);
        if (url.searchParams.has("error"))
          return new Response(
            "Calendar connection declined. Return to your agent to try again.",
            { status: 400 }
          );
        const state = await verifyCalendarState(
          env,
          url.searchParams.get("state") ?? ""
        );
        const ownerId = state.ownerId;
        if (!authorizedOwner(env, ownerId))
          return new Response("Unauthorized", { status: 401 });
        const code = url.searchParams.get("code");
        if (!code || code.length > 4096)
          return new Response("Missing authorization code", { status: 400 });
        const agent = await getAgentByName(env.ChatAgent, ownerId);
        await agent.completeCalendarConnection(state.nonce, code);
        return new Response(
          "Google Calendar connected with read-only access. Return to your agent. New events are provided as .ics files for you to review and import.",
          {
            headers: {
              "cache-control": "no-store",
              "referrer-policy": "no-referrer"
            }
          }
        );
      } catch {
        return new Response(
          "Calendar connection failed or expired. Use /calendar connect to try again.",
          { status: 400, headers: { "cache-control": "no-store" } }
        );
      }
    }
    if (path !== "/telegram/webhook")
      return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "POST" }
      });
    const allowedUserIds = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);
    if (
      !env.TELEGRAM_BOT_TOKEN ||
      !env.TELEGRAM_WEBHOOK_SECRET ||
      !allowedUserIds
    ) {
      return new Response("Telegram is not configured", { status: 503 });
    }
    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const parsed = telegramUpdateSchema.safeParse(body);
    if (!parsed.success) return new Response("Invalid update", { status: 400 });
    const message = authorizedMessage(parsed.data, allowedUserIds);
    if (message) {
      const agent = await getAgentByName(
        env.ChatAgent,
        `telegram:${message.chatId}`
      );
      await agent.receiveEvent({
        ownerId: `telegram:${message.chatId}`,
        eventId: String(message.updateId),
        destination: {
          channel: "telegram",
          address: String(message.chatId),
          conversationId: `telegram:${message.chatId}`
        },
        text: message.text,
        providerMessageId: String(message.messageId)
      });
    }
    return new Response("ok");
  }
} satisfies ExportedHandler<Env>;
