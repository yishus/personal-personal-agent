import { getAgentByName } from "agents";
import { z } from "zod";
import { actionSchema, actionText } from "./actions";
import { authenticateApi } from "./identity";
import { EventConflict } from "./channel-store";
import { handleMcpApi } from "./mcp-api";
import { JsonBodyError, readJsonBody } from "./http-body";

const conversation = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const inputSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    conversationId: conversation.default("main"),
    text: z.string().trim().min(1).max(16000).optional(),
    action: actionSchema.optional()
  })
  .strict()
  .refine(
    (input) => Boolean(input.text) !== Boolean(input.action),
    "Supply exactly one of text or action."
  );
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

export async function handleApi(request: Request, env: Env) {
  const auth = await authenticateApi(request, env);
  if (auth.status !== 200)
    return Response.json(
      {
        error: auth.status === 503 ? "API is not configured." : "Unauthorized."
      },
      { status: auth.status, headers }
    );
  const url = new URL(request.url);
  const mcpManagement =
    url.pathname === "/api/mcp" || url.pathname.startsWith("/api/mcp/");
  if (mcpManagement && !auth.permissions.includes("mcp:manage"))
    return Response.json(
      { error: "This API token does not have the mcp:manage permission." },
      { status: 403, headers }
    );
  const agent = await getAgentByName(env.ChatAgent, auth.ownerId);
  if (mcpManagement)
    return handleMcpApi(request, agent, headers, env.PUBLIC_BASE_URL);
  if (url.pathname === "/api/messages") {
    if (request.method !== "POST")
      return new Response("Method not allowed", {
        status: 405,
        headers: { ...headers, allow: "POST" }
      });
    let raw: unknown;
    try {
      raw = await readJsonBody(request);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof JsonBodyError ? error.message : "Invalid JSON."
        },
        { status: error instanceof JsonBodyError ? error.status : 400, headers }
      );
    }
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success)
      return Response.json(
        {
          error:
            "Supply id, optional conversationId, and exactly one of text or a supported action."
        },
        { status: 400, headers }
      );
    const input = parsed.data;
    try {
      const result = await agent.receiveEvent({
        ownerId: auth.ownerId,
        eventId: input.id,
        destination: {
          channel: "api",
          address: input.conversationId,
          conversationId: `api:${input.conversationId}`
        },
        text: input.action ? actionText(input.action) : input.text!
      });
      return Response.json(
        {
          id: input.id,
          conversationId: input.conversationId,
          status: result.done ? "completed" : "queued"
        },
        { status: 202, headers }
      );
    } catch (error) {
      // RPC preserves Error names, but not necessarily custom prototypes.
      if (
        error instanceof EventConflict ||
        (error instanceof Error &&
          error.message.includes("Event ID already used"))
      )
        return Response.json(
          { error: "Event ID already used for another message." },
          { status: 409, headers }
        );
      throw error;
    }
  }
  if (url.pathname === "/api/events") {
    if (request.method !== "GET")
      return new Response("Method not allowed", {
        status: 405,
        headers: { ...headers, allow: "GET" }
      });
    const after = url.searchParams.get("after") ?? "0";
    const selected = url.searchParams.get("conversationId");
    if (
      !/^\d+$/.test(after) ||
      !Number.isSafeInteger(Number(after)) ||
      (selected !== null && !conversation.safeParse(selected).success)
    )
      return Response.json(
        { error: "Invalid cursor or conversationId." },
        { status: 400, headers }
      );
    return Response.json(
      await agent.channelEvents(
        Number(after),
        selected ? `api:${selected}` : undefined
      ),
      { headers }
    );
  }
  const file = /^\/api\/files\/([1-9]\d*)$/.exec(url.pathname);
  if (file) {
    if (request.method !== "GET")
      return new Response("Method not allowed", {
        status: 405,
        headers: { ...headers, allow: "GET" }
      });
    if (!Number.isSafeInteger(Number(file[1])))
      return new Response("Not found", { status: 404, headers });
    const part = await agent.channelFile(Number(file[1]));
    if (!part) return new Response("Not found", { status: 404, headers });
    return new Response(part.content, {
      headers: {
        ...headers,
        "content-type": part.mediaType,
        "content-disposition": `attachment; filename="${part.filename.replace(/[^A-Za-z0-9_.-]/g, "_")}"`
      }
    });
  }
  return new Response("Not found", { status: 404, headers });
}
