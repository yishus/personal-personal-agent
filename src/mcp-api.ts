import { JsonBodyError, readJsonBody } from "./http-body.ts";
import {
  mcpServerInput,
  mcpServerId,
  type McpApiResult,
  type McpConnection,
  type McpServerInput
} from "./mcp-connections.ts";

interface McpEndpoint {
  listMcpConnections(): Promise<McpConnection[]>;
  addMcpConnection(
    input: McpServerInput,
    callbackOrigin: string
  ): Promise<McpApiResult>;
  deleteMcpConnection(id: string): Promise<McpApiResult>;
}

export async function handleMcpApi(
  request: Request,
  agent: McpEndpoint,
  headers: Record<string, string>,
  callbackOrigin?: string
) {
  const url = new URL(request.url);
  const collection = url.pathname === "/api/mcp/servers";
  const item = /^\/api\/mcp\/servers\/([A-Za-z0-9_-]{1,64})$/.exec(
    url.pathname
  );
  if (!collection && !item)
    return new Response("Not found", { status: 404, headers });
  if (request.method === "GET") {
    const connections = await agent.listMcpConnections();
    if (collection) return Response.json({ connections }, { headers });
    const connection = connections.find((server) => server.id === item![1]);
    return Response.json(
      connection ? { connection } : { error: "MCP connection not found." },
      { status: connection ? 200 : 404, headers }
    );
  }
  let result: McpApiResult;
  if (collection && request.method === "POST") {
    try {
      const parsed = mcpServerInput.safeParse(
        await readJsonBody(request, 16 * 1024)
      );
      if (!parsed.success)
        return Response.json(
          {
            error:
              "Supply a name, public HTTPS URL, optional transport and authentication headers."
          },
          { status: 400, headers }
        );
      result = await agent.addMcpConnection(
        parsed.data,
        callbackOrigin ?? url.origin
      );
    } catch (error) {
      if (!(error instanceof JsonBodyError)) throw error;
      return Response.json(
        { error: error.message },
        { status: error.status, headers }
      );
    }
  } else if (
    item &&
    request.method === "DELETE" &&
    mcpServerId.safeParse(item[1]).success
  ) {
    result = await agent.deleteMcpConnection(item[1]);
  } else {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...headers, allow: collection ? "GET, POST" : "GET, DELETE" }
    });
  }
  return result.status === 204
    ? new Response(null, { status: 204, headers })
    : Response.json(result.body, { status: result.status, headers });
}
