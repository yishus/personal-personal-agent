import type { ModelMessage } from "ai";
import type {
  Destination,
  IncomingEvent,
  OutboundPart,
  DeliveryContext
} from "./channels";
import type { PublicResearchTask } from "./research-session";

const RETENTION = 7 * 86400_000;
export class EventConflict extends Error {}

export class ChannelStore {
  private sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS channel_destinations (
      id INTEGER PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL,
      conversation_id TEXT NOT NULL, UNIQUE(channel, address, conversation_id)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS channel_sequence (
      id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL
    )`);
    this.sql.exec("INSERT OR IGNORE INTO channel_sequence VALUES (1, 0)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS channel_conversations (
      id TEXT PRIMARY KEY, history_json TEXT NOT NULL DEFAULT '[]', research_json TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS delivery_batches (
      id TEXT PRIMARY KEY, parts_json TEXT NOT NULL, expires_at INTEGER, sensitive INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS channel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_key TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL, kind TEXT NOT NULL, source_event_id TEXT,
      part_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      sensitive INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS channel_events_expiry ON channel_events(expires_at)"
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS delivery_batches_expiry ON delivery_batches(expires_at)"
    );
  }

  private nextId() {
    return this.sql
      .exec<{ value: number }>(
        "UPDATE channel_sequence SET value = value + 1 WHERE id = 1 RETURNING value"
      )
      .one().value;
  }

  destinationId(destination: Destination) {
    const existing = this.sql
      .exec<{ id: number }>(
        "SELECT id FROM channel_destinations WHERE channel = ? AND address = ? AND conversation_id = ?",
        destination.channel,
        destination.address,
        destination.conversationId
      )
      .toArray()[0];
    if (existing) return existing.id;
    const id = this.nextId();
    this.sql.exec(
      "INSERT INTO channel_destinations VALUES (?, ?, ?, ?)",
      id,
      destination.channel,
      destination.address,
      destination.conversationId
    );
    return id;
  }

  destination(id: number): Destination {
    const row = this.sql
      .exec<{ channel: string; address: string; conversation_id: string }>(
        "SELECT * FROM channel_destinations WHERE id = ?",
        id
      )
      .toArray()[0];
    if (row)
      return {
        channel: row.channel,
        address: row.address,
        conversationId: row.conversation_id
      };
    throw new Error("Delivery destination missing.");
  }

  enqueue(event: IncomingEvent, fingerprint: string) {
    const eventId = `${event.destination.channel}:${event.eventId}`;
    const existing = this.sql
      .exec<{ message_id: number; done: number; fingerprint: string }>(
        "SELECT message_id, done, fingerprint FROM inbox_jobs WHERE event_id = ?",
        eventId
      )
      .toArray()[0];
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new EventConflict("Event ID already used for another message.");
      return {
        id: existing.message_id,
        done: Boolean(existing.done),
        inserted: false
      };
    }
    const id = this.nextId();
    const destinationId = this.destinationId(event.destination);
    this.sql.exec(
      `INSERT INTO inbox_jobs (message_id, destination_id, text, created_at, event_id, fingerprint, conversation_id, provider_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      destinationId,
      event.text,
      Date.now(),
      eventId,
      fingerprint,
      event.destination.conversationId,
      event.providerMessageId ?? null
    );
    return { id, done: false, inserted: true };
  }

  history(id: string): ModelMessage[] | undefined {
    const row = this.sql
      .exec<{ history_json: string }>(
        "SELECT history_json FROM channel_conversations WHERE id = ?",
        id
      )
      .toArray()[0];
    return row ? JSON.parse(row.history_json) : undefined;
  }
  saveHistory(id: string, history: ModelMessage[]) {
    this.sql.exec(
      "INSERT INTO channel_conversations (id, history_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET history_json = excluded.history_json",
      id,
      JSON.stringify(history)
    );
  }
  research(id: string): PublicResearchTask | undefined {
    const row = this.sql
      .exec<{ research_json: string | null }>(
        "SELECT research_json FROM channel_conversations WHERE id = ?",
        id
      )
      .toArray()[0];
    return row?.research_json ? JSON.parse(row.research_json) : undefined;
  }
  saveResearch(id: string, task: PublicResearchTask | null) {
    this.sql.exec(
      "INSERT INTO channel_conversations (id, research_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET research_json = excluded.research_json",
      id,
      task ? JSON.stringify(task) : null
    );
  }

  batch(key: string, render: () => OutboundPart[], expiresAt?: number) {
    this.prune();
    const saved = this.sql
      .exec<{ parts_json: string }>(
        "SELECT parts_json FROM delivery_batches WHERE id = ?",
        key
      )
      .toArray()[0];
    if (saved) return JSON.parse(saved.parts_json) as OutboundPart[];
    const parts = render();
    this.sql.exec(
      "INSERT INTO delivery_batches VALUES (?, ?, ?, ?)",
      key,
      JSON.stringify(parts),
      expiresAt ?? null,
      expiresAt ? 1 : 0
    );
    return parts;
  }
  completeBatch(key: string) {
    this.sql.exec("DELETE FROM delivery_batches WHERE id = ?", key);
  }
  clearBatches(prefix: string, keep?: string) {
    this.sql.exec(
      "DELETE FROM delivery_batches WHERE substr(id, 1, ?) = ? AND (? IS NULL OR id <> ?)",
      prefix.length,
      prefix,
      keep ?? null,
      keep ?? null
    );
  }
  clearSensitive() {
    this.sql.exec("DELETE FROM channel_events WHERE sensitive = 1");
    this.sql.exec("DELETE FROM delivery_batches WHERE sensitive = 1");
  }
  prune(now = Date.now()) {
    this.sql.exec("DELETE FROM channel_events WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM delivery_batches WHERE expires_at <= ?", now);
  }
  append(
    destination: Destination,
    part: OutboundPart,
    context: DeliveryContext
  ) {
    this.prune();
    this.sql.exec(
      `INSERT OR IGNORE INTO channel_events
      (delivery_key, conversation_id, kind, source_event_id, part_json, created_at, expires_at, sensitive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      context.key,
      destination.conversationId,
      context.kind,
      context.sourceEventId ?? null,
      JSON.stringify(part),
      Date.now(),
      context.expiresAt ?? Date.now() + RETENTION,
      context.expiresAt ? 1 : 0
    );
  }
  events(after: number, conversationId?: string) {
    this.prune();
    const rows = this.sql
      .exec<{
        id: number;
        conversation_id: string;
        kind: string;
        source_event_id: string | null;
        part_json: string;
        created_at: number;
      }>(
        "SELECT * FROM channel_events WHERE id > ? AND (? IS NULL OR conversation_id = ?) ORDER BY id LIMIT 100",
        after,
        conversationId ?? null,
        conversationId ?? null
      )
      .toArray();
    return {
      events: rows.map((row) => {
        const part = JSON.parse(row.part_json) as OutboundPart;
        return {
          id: row.id,
          conversationId: row.conversation_id.replace(/^api:/, ""),
          kind: row.kind,
          sourceEventId: row.source_event_id,
          createdAt: row.created_at,
          ...(part.type === "text"
            ? { type: "text", text: part.text }
            : {
                type: "file",
                filename: part.filename,
                mediaType: part.mediaType,
                downloadUrl: `/api/files/${row.id}`
              })
        };
      }),
      nextCursor: rows.at(-1)?.id ?? after
    };
  }
  file(id: number) {
    this.prune();
    const row = this.sql
      .exec<{ part_json: string }>(
        "SELECT part_json FROM channel_events WHERE id = ?",
        id
      )
      .toArray()[0];
    if (!row) return null;
    const part = JSON.parse(row.part_json) as OutboundPart;
    return part.type === "file" ? part : null;
  }
}
