import { ownerIdSchema } from "./identity.ts";
import { z } from "zod";
import { disconnectGoogle, revokeGoogleCredentials } from "./google-oauth.ts";
import { validTimezone } from "./scheduling.ts";

export const calendarEventInput = z
  .object({
    summary: z.string().trim().min(1).max(300),
    description: z.string().max(4000).nullable(),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    timezone: z.string().refine(validTimezone, "Use an IANA timezone.")
  })
  .refine(
    (v) => Date.parse(v.end) > Date.parse(v.start),
    "End must follow start."
  );
export type CalendarEvent = z.infer<typeof calendarEventInput>;
export const calendarFileInput = z.object({
  events: z.array(calendarEventInput).min(1).max(20)
});
export const CALENDAR_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";

function calendarText(text: string) {
  return (
    text
      .replaceAll("\\", "\\\\")
      .replace(/\r\n|\r|\n/g, "\\n")
      .replaceAll(";", "\\;")
      .replaceAll(",", "\\,")
      // eslint-disable-next-line no-control-regex -- iCalendar text excludes control bytes.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

function foldCalendarLine(line: string) {
  const encoder = new TextEncoder();
  let folded = "";
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) {
      folded += "\r\n ";
      bytes = 1;
    }
    folded += character;
    bytes += size;
  }
  return folded;
}

function calendarTimestamp(value: string | number) {
  return new Date(value).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

// UTC timestamps preserve the supplied instants without client-specific TZID
// definitions. No scheduling METHOD, attendees, URLs, attachments or alarms.
export function calendarFile(
  id: string,
  input: z.infer<typeof calendarFileInput>,
  createdAt: number
) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Invalid calendar file ID.");
  const { events } = calendarFileInput.parse(input);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Personal Agent//Calendar Draft//EN",
    "CALSCALE:GREGORIAN",
    ...events.flatMap((event, index) => [
      "BEGIN:VEVENT",
      `UID:${id}-${index}@personal-agent.invalid`,
      `DTSTAMP:${calendarTimestamp(createdAt)}`,
      `DTSTART:${calendarTimestamp(event.start)}`,
      `DTEND:${calendarTimestamp(event.end)}`,
      `SUMMARY:${calendarText(event.summary)}`,
      `DESCRIPTION:${calendarText(event.description ?? "")}`,
      "END:VEVENT"
    ]),
    "END:VCALENDAR"
  ];
  return lines.map(foldCalendarLine).join("\r\n") + "\r\n";
}
export type CalendarEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CALENDAR_STATE_SECRET?: string;
  PUBLIC_BASE_URL?: string;
};
type Token = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  generation: string;
};

function configured(env: CalendarEnv) {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.CALENDAR_STATE_SECRET ||
    !env.PUBLIC_BASE_URL
  )
    throw new Error(
      "Configure Google Calendar OAuth credentials and PUBLIC_BASE_URL first."
    );
  const base = new URL(env.PUBLIC_BASE_URL);
  if (base.protocol !== "https:" && base.hostname !== "localhost")
    throw new Error("PUBLIC_BASE_URL must use HTTPS.");
  return new URL("/connectors/google/callback", base).href;
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
export async function verifyCalendarState(env: CalendarEnv, state: string) {
  if (!env.CALENDAR_STATE_SECRET || state.length > 2000)
    throw new Error("Invalid connection state.");
  const [body, signature, extra] = state.split(".");
  if (
    !body ||
    !signature ||
    extra ||
    !(await crypto.subtle.verify(
      "HMAC",
      await stateKey(env.CALENDAR_STATE_SECRET),
      decode(signature),
      new TextEncoder().encode(body)
    ))
  )
    throw new Error("Invalid connection state.");
  const data = z
    .object({
      ownerId: ownerIdSchema,
      nonce: z.string().uuid(),
      expires: z.number()
    })
    .parse(JSON.parse(new TextDecoder().decode(decode(body))));
  if (data.expires <= Date.now())
    throw new Error("Connection link expired. Use /calendar connect again.");
  return data;
}

export class GoogleCalendar {
  private storage: DurableObjectStorage;
  private env: CalendarEnv;
  constructor(storage: DurableObjectStorage, env: CalendarEnv) {
    this.storage = storage;
    this.env = env;
  }

  async connect(ownerId: string) {
    const redirectUri = configured(this.env);
    if (!(await this.revokeCredentials([])))
      throw new Error(
        "Previous Google revocation failed. Retry /calendar disconnect; if this persists, remove this app at https://myaccount.google.com/connections and try again."
      );
    const nonce = crypto.randomUUID();
    const expires = Date.now() + 10 * 60_000;
    await this.storage.transaction(async (tx) => {
      await tx.put("calendar.generation", nonce);
      await tx.put("calendar.oauth", {
        nonce,
        expires,
        scope: CALENDAR_READ_SCOPE
      });
    });
    const body = encode(
      new TextEncoder().encode(
        JSON.stringify({
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
          await stateKey(this.env.CALENDAR_STATE_SECRET!),
          new TextEncoder().encode(body)
        )
      )
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: CALENDAR_READ_SCOPE,
      include_granted_scopes: "false",
      access_type: "offline",
      prompt: "consent",
      state: `${body}.${signature}`
    }).toString();
    return url.href;
  }

  async complete(nonce: string, code: string) {
    const redirectUri = configured(this.env);
    const claimed = await this.storage.transaction(async (tx) => {
      const pending = await tx.get<{
        nonce: string;
        expires: number;
        scope: string;
      }>("calendar.oauth");
      if (
        !pending ||
        pending.nonce !== nonce ||
        pending.expires <= Date.now() ||
        pending.scope !== CALENDAR_READ_SCOPE ||
        (await tx.get("calendar.generation")) !== nonce
      )
        return false;
      await tx.delete("calendar.oauth");
      return true;
    });
    if (!claimed) throw new Error("Connection link expired or already used.");
    const token = await this.exchange({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });
    if (token.scope !== CALENDAR_READ_SCOPE) {
      await this.revokeCredentials([token.refresh_token ?? token.access_token]);
      throw new Error(
        "Google did not grant read-only calendar access. Remove this app at https://myaccount.google.com/connections, then use /calendar connect again."
      );
    }
    if (!token.refresh_token) {
      await this.revokeCredentials([token.access_token]);
      throw new Error(
        "Google did not return offline access. Reconnect and grant consent."
      );
    }
    const saved = await this.storage.transaction(async (tx) => {
      if ((await tx.get("calendar.generation")) !== nonce) return false;
      await tx.put("calendar.token", {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        scope: CALENDAR_READ_SCOPE,
        generation: nonce,
        expires_at: Date.now() + token.expires_in * 1000
      });
      return true;
    });
    if (!saved) {
      await this.revokeCredentials([token.refresh_token]);
      throw new Error(
        "Google connection was cancelled. Use /calendar connect again."
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
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...values,
        client_id: this.env.GOOGLE_CLIENT_ID!,
        client_secret: this.env.GOOGLE_CLIENT_SECRET!
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok)
      throw new Error(
        "Google authorization failed. Use /calendar connect again."
      );
    return z
      .object({
        access_token: z.string(),
        refresh_token: z.string().optional(),
        expires_in: z.number().positive(),
        scope: z.string().optional()
      })
      .parse(await response.json());
  }

  private async accessToken() {
    const token = await this.storage.get<Token>("calendar.token");
    if (!token)
      throw new Error("Connect your calendar with /calendar connect first.");
    if (token.scope !== CALENDAR_READ_SCOPE) {
      await this.disconnect();
      throw new Error(
        "Calendar permissions must be read-only. Use /calendar connect again."
      );
    }
    if (token.expires_at > Date.now() + 60_000) return token.access_token;
    const refreshed = await this.exchange({
      refresh_token: token.refresh_token,
      grant_type: "refresh_token"
    });
    if (refreshed.scope && refreshed.scope !== CALENDAR_READ_SCOPE) {
      await this.disconnect();
      await this.revokeCredentials([
        refreshed.refresh_token ?? refreshed.access_token
      ]);
      throw new Error(
        "Calendar permissions must be read-only. Use /calendar connect again."
      );
    }
    const saved = await this.storage.transaction(async (tx) => {
      const current = await tx.get<Token>("calendar.token");
      if (
        !current ||
        current.refresh_token !== token.refresh_token ||
        current.generation !== token.generation
      )
        return false;
      await tx.put("calendar.token", {
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
      throw new Error("Google was disconnected during the request.");
    }
    return refreshed.access_token;
  }

  async events(timeMin: string, timeMax: string) {
    const range = z
      .object({
        timeMin: z.iso.datetime({ offset: true }),
        timeMax: z.iso.datetime({ offset: true })
      })
      .parse({ timeMin, timeMax });
    if (Date.parse(range.timeMax) <= Date.parse(range.timeMin))
      throw new Error("End must follow start.");
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    );
    url.search = new URLSearchParams({
      ...range,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50"
    }).toString();
    const generation = await this.storage.get<string>("calendar.generation");
    const response = await fetch(url, {
      redirect: "manual",
      headers: { authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok)
      throw new Error(
        "Could not read Google Calendar. Reconnect if access expired."
      );
    const data = await response.json<{
      items?: unknown[];
      nextPageToken?: string;
    }>();
    if (
      (await this.storage.get("calendar.generation")) !== generation ||
      !(await this.storage.get("calendar.token"))
    )
      throw new Error("Google was disconnected during the request.");
    return {
      trust: "historical_calendar_data",
      events: data.items ?? [],
      truncated: Boolean(data.nextPageToken)
    };
  }
}
