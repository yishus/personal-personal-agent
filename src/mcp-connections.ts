import { isIP } from "node:net";
import { z } from "zod";
import type { Agent } from "agents";

const blockedHosts = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "test",
  "invalid",
  "onion"
];
const reservedHeader =
  /^(?:host|connection|content-length|content-type|accept|transfer-encoding|upgrade|proxy-authorization|proxy-connection|origin|referer|mcp-.+)$/i;

export const mcpServerInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: z
      .string()
      .max(2048)
      .transform((input, ctx) => {
        try {
          const url = new URL(input);
          const host = url.hostname.replace(/\.$/, "");
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            url.hash ||
            isIP(host) ||
            host.includes(":") ||
            !host.includes(".") ||
            !/^[a-z0-9.-]+$/i.test(host) ||
            blockedHosts.some(
              (suffix) => host === suffix || host.endsWith(`.${suffix}`)
            )
          )
            throw new Error();
          url.hostname = host;
          return url.href;
        } catch {
          ctx.addIssue({
            code: "custom",
            message:
              "Use a public HTTPS MCP URL without userinfo, IP addresses, custom ports or fragments."
          });
          return z.NEVER;
        }
      }),
    transport: z.enum(["streamable-http", "sse", "auto"]).default("auto"),
    headers: z
      .record(
        z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        z
          .string()
          .min(1)
          .max(8192)
          .regex(/^[\x20-\x7e]+$/)
      )
      .default({})
      .superRefine((headers, ctx) => {
        const names = Object.keys(headers).map((name) => name.toLowerCase());
        if (
          names.length > 16 ||
          new Set(names).size !== names.length ||
          names.some((name) => reservedHeader.test(name))
        )
          ctx.addIssue({
            code: "custom",
            message:
              "Use at most 16 unique authentication headers; transport headers are reserved."
          });
      })
  })
  .strict();
export type McpServerInput = z.infer<typeof mcpServerInput>;
export const mcpServerId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

type McpHost = Pick<
  Agent,
  "addMcpServer" | "removeMcpServer" | "getMcpServers"
>;
export type McpConnection = {
  id: string;
  name: string;
  url: string;
  state: string;
  authUrl: string | null;
  tools: string[];
};
export type McpApiResult = {
  status: number;
  body: { connection?: McpConnection; id?: string; error?: string };
};

export function mcpCallbackPath(ownerId: string) {
  return `/connectors/mcp/${encodeURIComponent(ownerId)}/callback`;
}

// SDK records contain credentials, provider instructions and diagnostic text.
// Expose only the fields needed to manage a connection, never raw SDK state.
export function listMcpConnections(
  host: Pick<McpHost, "getMcpServers">
): McpConnection[] {
  const { servers, tools } = host.getMcpServers();
  return Object.entries(servers).map(([id, server]) => {
    const url = new URL(server.server_url);
    url.search = "";
    url.hash = "";
    return {
      id,
      name: server.name,
      url: url.href,
      state: server.state,
      authUrl:
        server.state === "authenticating"
          ? publicAuthUrl(server.auth_url)
          : null,
      tools: tools
        .filter((tool) => tool.serverId === id)
        .map((tool) => tool.name)
    };
  });
}

function publicAuthUrl(value: string | null) {
  if (!value) return null;
  try {
    return mcpServerInput.shape.url.parse(value);
  } catch {
    return null;
  }
}

export async function addMcpConnection(
  host: McpHost,
  ownerId: string,
  input: unknown,
  callbackOrigin: string
): Promise<McpApiResult> {
  const parsed = mcpServerInput.safeParse(input);
  if (!parsed.success)
    return {
      status: 400,
      body: {
        error:
          "Supply a name, public HTTPS URL, optional transport and authentication headers."
      }
    };
  let origin: URL;
  try {
    origin = new URL(callbackOrigin);
    if (
      origin.username ||
      origin.password ||
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
      )
    )
      throw new Error();
  } catch {
    return {
      status: 400,
      body: {
        error:
          "Configure a public HTTPS callback origin (or HTTP localhost for development)."
      }
    };
  }
  const connections = listMcpConnections(host);
  const existing = connections.find(
    (connection) =>
      connection.name.toLowerCase() === parsed.data.name.toLowerCase()
  );
  if (existing)
    return {
      status: 409,
      body: {
        id: existing.id,
        error:
          "An MCP connection already uses this name. Delete it before replacing its URL or credentials."
      }
    };
  if (connections.length >= 20)
    return {
      status: 409,
      body: { error: "At most 20 MCP connections are supported per owner." }
    };
  const id = `mcp-${crypto.randomUUID()}`;
  try {
    const result = await host.addMcpServer(parsed.data.name, parsed.data.url, {
      id,
      callbackHost: origin.origin,
      callbackPath: mcpCallbackPath(ownerId),
      transport: { type: parsed.data.transport, headers: parsed.data.headers },
      retry: { maxAttempts: 1 }
    });
    const connection = listMcpConnections(host).find(
      (server) => server.id === result.id
    );
    if (!connection) throw new Error();
    if (result.state === "authenticating") {
      connection.authUrl = publicAuthUrl(result.authUrl);
      if (!connection.authUrl) throw new Error();
    }
    return {
      status: result.state === "authenticating" ? 202 : 201,
      body: { connection }
    };
  } catch {
    // Provider exceptions may contain auth headers, secret query parameters
    // or OAuth codes. A failed SDK registration can be inspected/deleted by ID.
    return {
      status: 502,
      body: {
        id,
        error:
          "Could not connect to the MCP server. Check its URL and credentials. List connections to inspect or remove the saved registration."
      }
    };
  }
}

export async function deleteMcpConnection(
  host: McpHost,
  id: string
): Promise<McpApiResult> {
  if (
    !mcpServerId.safeParse(id).success ||
    !listMcpConnections(host).some((server) => server.id === id)
  )
    return { status: 404, body: { error: "MCP connection not found." } };
  try {
    await host.removeMcpServer(id);
    return { status: 204, body: {} };
  } catch {
    return {
      status: 502,
      body: { error: "Could not remove the MCP connection. Try again." }
    };
  }
}
