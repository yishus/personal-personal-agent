import { ownerIdSchema } from "./identity.ts";
import { z } from "zod";
import {
  disconnectGoogle,
  googleRevocationPending,
  revokeGoogleCredentials
} from "./google-oauth.ts";

export const EMAIL_READ_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
export type EmailEnv = {
  EMAIL_STATE_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PUBLIC_BASE_URL?: string;
};
type Token = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  generation: string;
  oauthClient: string;
};
type Pending = {
  nonce: string;
  expires: number;
  verifier: string;
  oauthClient: string;
};

export class EmailError extends Error {}

function configuration(env: EmailEnv) {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.EMAIL_STATE_SECRET ||
    env.EMAIL_STATE_SECRET.length < 32 ||
    !env.PUBLIC_BASE_URL
  )
    throw new EmailError(
      "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, EMAIL_STATE_SECRET (at least 32 characters), and PUBLIC_BASE_URL first."
    );
  const base = new URL(env.PUBLIC_BASE_URL);
  if (base.protocol !== "https:" || base.username || base.password)
    throw new EmailError("PUBLIC_BASE_URL must be a public HTTPS origin.");
  return new URL("/connectors/gmail/callback", base).href;
}

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0)
  );
}
async function stateKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
export async function verifyEmailState(env: EmailEnv, state: string) {
  configuration(env);
  if (state.length > 2000)
    throw new EmailError("Invalid email connection state.");
  const [body, signature, extra] = state.split(".");
  if (
    !body ||
    !signature ||
    extra ||
    !(await crypto.subtle.verify(
      "HMAC",
      await stateKey(env.EMAIL_STATE_SECRET!),
      decode(signature),
      new TextEncoder().encode(body)
    ))
  )
    throw new EmailError("Invalid email connection state.");
  const data = z
    .object({
      kind: z.literal("gmail-readonly"),
      ownerId: ownerIdSchema,
      nonce: z.string().uuid(),
      expires: z.number()
    })
    .parse(JSON.parse(new TextDecoder().decode(decode(body))));
  if (data.expires <= Date.now())
    throw new EmailError(
      "Email connection link expired. Use /email connect again."
    );
  return data;
}

// Bound response bytes before parsing; never relay Google error bodies or URLs.
async function json(
  response: Response,
  maxBytes = 512 * 1024
): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new EmailError(
      "Google email request failed. Reconnect if access expired."
    );
  }
  if (!response.body) throw new EmailError("Empty Google email response.");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes)
        throw new EmailError("Email response is too large to read safely.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class GoogleEmail {
  private generation?: string;
  private storage: DurableObjectStorage;
  private env: EmailEnv;
  constructor(storage: DurableObjectStorage, env: EmailEnv) {
    this.storage = storage;
    this.env = env;
  }

  async isCurrent() {
    const token = await this.storage.get<Token>("email.token");
    return Boolean(this.generation && token?.generation === this.generation);
  }

  async status() {
    return {
      connected: Boolean(await this.storage.get("email.token")),
      revocationPending: await googleRevocationPending(this.storage)
    };
  }

  async connect(ownerId: string) {
    const redirect = configuration(this.env);
    if ((await this.status()).connected)
      throw new EmailError(
        "Email is already connected. Use /email disconnect before connecting another account."
      );
    if (!(await this.revokeCredentials([])))
      throw new EmailError(
        "Previous Google revocation failed. Retry /email disconnect or remove this Google app at https://myaccount.google.com/connections before reconnecting."
      );
    const nonce = crypto.randomUUID();
    const expires = Date.now() + 10 * 60_000;
    const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
    await this.storage.transaction(async (tx) => {
      await tx.put("email.generation", nonce);
      await tx.put("email.oauth", {
        nonce,
        expires,
        verifier,
        oauthClient: this.env.GOOGLE_CLIENT_ID
      });
    });
    const body = encode(
      new TextEncoder().encode(
        JSON.stringify({
          kind: "gmail-readonly",
          ownerId: ownerIdSchema.parse(ownerId),
          nonce,
          expires
        })
      )
    );
    const signature = encode(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await stateKey(this.env.EMAIL_STATE_SECRET!),
          new TextEncoder().encode(body)
        )
      )
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirect,
      response_type: "code",
      scope: EMAIL_READ_SCOPE,
      include_granted_scopes: "false",
      access_type: "offline",
      prompt: "consent select_account",
      state: `${body}.${signature}`,
      code_challenge_method: "S256",
      code_challenge: encode(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier)
          )
        )
      )
    }).toString();
    return url.href;
  }

  async complete(nonce: string, code: string) {
    const redirect = configuration(this.env);
    const pending = await this.storage.transaction(async (tx) => {
      const value = await tx.get<Pending>("email.oauth");
      if (
        !value ||
        value.nonce !== nonce ||
        value.expires <= Date.now() ||
        value.oauthClient !== this.env.GOOGLE_CLIENT_ID
      )
        return null;
      await tx.delete("email.oauth");
      return value;
    });
    if (!pending)
      throw new EmailError("Email connection link expired or already used.");
    const token = await this.exchange({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirect,
      code_verifier: pending.verifier
    });
    if (token.scope !== EMAIL_READ_SCOPE || !token.refresh_token) {
      await this.revokeCredentials([token.refresh_token ?? token.access_token]);
      throw new EmailError(
        "Google must grant exactly read-only Gmail access with offline access. Remove this Google app at https://myaccount.google.com/connections and reconnect."
      );
    }
    const saved = await this.storage.transaction(async (tx) => {
      if ((await tx.get("email.generation")) !== nonce) return false;
      await tx.put("email.token", {
        ...token,
        generation: nonce,
        oauthClient: this.env.GOOGLE_CLIENT_ID!,
        expires_at: Date.now() + token.expires_in * 1000
      });
      return true;
    });
    if (!saved) {
      await this.revokeCredentials([token.refresh_token]);
      throw new EmailError(
        "Email connection was cancelled. Use /email connect again."
      );
    }
  }

  async disconnect() {
    return disconnectGoogle(this.storage);
  }

  private async revokeCredentials(credentials: string[]) {
    return revokeGoogleCredentials(this.storage, credentials);
  }

  private async exchange(values: Record<string, string>) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...values,
        client_id: this.env.GOOGLE_CLIENT_ID!,
        client_secret: this.env.GOOGLE_CLIENT_SECRET!
      }),
      signal: AbortSignal.timeout(15_000)
    });
    return z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        expires_in: z.number().positive(),
        scope: z.string().optional()
      })
      .parse(await json(response, 32_768));
  }

  private async accessToken() {
    const token = await this.storage.get<Token>("email.token");
    if (!token)
      throw new EmailError("Connect Gmail with /email connect first.");
    if (token.oauthClient !== this.env.GOOGLE_CLIENT_ID) {
      await this.disconnect();
      throw new EmailError(
        "Gmail OAuth configuration changed. Use /email connect again."
      );
    }
    this.generation ??= token.generation;
    if (token.generation !== this.generation)
      throw new EmailError(
        "The email connection changed during this request. Please send a new request."
      );
    if (token.scope !== EMAIL_READ_SCOPE) {
      await this.disconnect();
      throw new EmailError(
        "Email permissions must be read-only. Use /email connect again."
      );
    }
    if (token.expires_at > Date.now() + 60_000) return token.access_token;
    configuration(this.env);
    const refreshed = await this.exchange({
      refresh_token: token.refresh_token,
      grant_type: "refresh_token"
    });
    if (refreshed.scope && refreshed.scope !== EMAIL_READ_SCOPE) {
      await this.disconnect();
      await this.revokeCredentials([
        refreshed.refresh_token ?? refreshed.access_token
      ]);
      throw new EmailError(
        "Email permissions must remain read-only. Reconnect Gmail."
      );
    }
    const saved = await this.storage.transaction(async (tx) => {
      const current = await tx.get<Token>("email.token");
      if (
        !current ||
        current.generation !== token.generation ||
        current.refresh_token !== token.refresh_token
      )
        return false;
      await tx.put("email.token", {
        ...token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? token.refresh_token,
        expires_at: Date.now() + refreshed.expires_in * 1000
      });
      return true;
    });
    if (!saved) {
      await this.revokeCredentials([
        refreshed.refresh_token ?? refreshed.access_token
      ]);
      throw new EmailError("Email was disconnected during the request.");
    }
    return refreshed.access_token;
  }

  // Only these fixed GET endpoints can use the credential. No URL/method tool.
  private async get(
    path: string,
    query: URLSearchParams,
    signal?: AbortSignal
  ) {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages${path}`
    );
    url.search = query.toString();
    const access = await this.accessToken();
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { authorization: `Bearer ${access}` },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000)
    });
    const data = await json(response);
    if (!(await this.isCurrent()))
      throw new EmailError("Email was disconnected during the request.");
    return data;
  }

  async search(query: string, limit: number, signal?: AbortSignal) {
    z.string().trim().min(1).max(500).parse(query);
    z.number().int().min(1).max(10).parse(limit);
    const data = z
      .object({
        messages: z
          .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }))
          .max(10)
          .optional(),
        nextPageToken: z.string().optional()
      })
      .parse(
        await this.get(
          "",
          new URLSearchParams({
            q: query,
            maxResults: String(limit),
            includeSpamTrash: "false",
            fields: "messages(id),nextPageToken"
          }),
          signal
        )
      );
    return {
      ids: (data.messages ?? []).slice(0, limit).map((m) => m.id),
      truncated: Boolean(data.nextPageToken)
    };
  }

  async read(id: string, signal?: AbortSignal) {
    z.string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .parse(id);
    return emailText(
      await this.get(
        `/${encodeURIComponent(id)}`,
        new URLSearchParams({
          format: "full",
          fields: "id,internalDate,payload"
        }),
        signal
      )
    );
  }
}

type Part = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string };
  parts?: Part[];
};
function clean(value: string) {
  return value.replace(
    // eslint-disable-next-line no-control-regex -- Remove invisible display controls.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
    ""
  );
}
export function emailText(value: unknown) {
  const data = value as { id?: string; internalDate?: string; payload?: Part };
  const headers = Array.isArray(data.payload?.headers)
    ? data.payload.headers
    : [];
  const header = (name: string) =>
    clean(
      headers.find((h) => h.name.toLowerCase() === name)?.value ?? ""
    ).slice(0, 500);
  const plain: string[] = [],
    html: string[] = [];
  let visited = 0;
  function visit(part: Part, depth: number) {
    if (
      ++visited > 100 ||
      depth > 10 ||
      part.filename ||
      part.body?.attachmentId ||
      part.headers?.some(
        (h) =>
          h.name.toLowerCase() === "content-disposition" &&
          /^attachment\b/i.test(h.value)
      )
    )
      return;
    if (
      (part.mimeType === "text/plain" || part.mimeType === "text/html") &&
      part.body?.data
    ) {
      const text = new TextDecoder().decode(decode(part.body.data));
      (part.mimeType === "text/plain" ? plain : html).push(text);
    }
    if (part.mimeType?.startsWith("multipart/") && Array.isArray(part.parts))
      for (const child of part.parts.slice(0, 100)) visit(child, depth + 1);
  }
  if (data.payload) visit(data.payload, 0);
  const text = clean(
    plain.length
      ? plain.join("\n")
      : html
          .join("\n")
          .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
          .replace(/<[^>]*>/g, " ")
          .replace(
            /&(?:amp|lt|gt|quot|apos|nbsp);/g,
            (s) =>
              ({
                "&amp;": "&",
                "&lt;": "<",
                "&gt;": ">",
                "&quot;": '"',
                "&apos;": "'",
                "&nbsp;": " "
              })[s]!
          )
  ).trim();
  return {
    trust: "untrusted_email_content",
    id: data.id,
    from: header("from"),
    to: header("to"),
    subject: header("subject"),
    date: header("date"),
    text: text.slice(0, 12_000),
    truncated: text.length > 12_000 || visited > 100,
    bodyUnavailable: !text,
    attachmentsOmitted: true
  };
}
