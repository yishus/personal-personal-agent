import { z } from "zod";

export type JournalEntry = {
  id: string;
  source_message_id: number;
  content: string;
  occurred_at: number;
  recorded_at: number;
  timezone: string;
  local_date: string;
};

export function localDate(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(timestamp);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function validJournalDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

export const journalSearchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .nullable()
      .describe(
        "Plain keywords, not SQL or FTS syntax. Null to browse a date range."
      ),
    match: z
      .enum(["all", "any"])
      .describe(
        "All requires every keyword. Any allows alternatives such as distract distracted focus."
      ),
    fromDate: z
      .string()
      .refine(validJournalDate, "Use a valid YYYY-MM-DD date.")
      .nullable(),
    toDate: z
      .string()
      .refine(validJournalDate, "Use a valid YYYY-MM-DD date.")
      .nullable(),
    offset: z.number().int().min(0).max(10_000)
  })
  .refine(
    (input) =>
      input.query !== null || input.fromDate !== null || input.toDate !== null,
    {
      message: "Provide search keywords or a date range."
    }
  )
  .refine(
    (input) =>
      !input.fromDate || !input.toDate || input.fromDate <= input.toDate,
    {
      message: "The start date must be on or before the end date."
    }
  );

export type JournalSearchInput = z.infer<typeof journalSearchInput>;
export type JournalSearchEntry = Omit<JournalEntry, "content"> & {
  excerpt: string;
  excerptTruncated: boolean;
};

const SEARCH_PAGE_SIZE = 10;
const SEARCH_EXCERPT_LENGTH = 1600;

function searchExpression(query: string, match: "all" | "any"): string {
  // Tokenize as plain words and quote each token. Parameter binding alone
  // would still let arbitrary FTS operators/column filters alter the query.
  const terms = [
    ...new Set(query.normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
  ];
  if (!terms.length)
    throw new Error("Search keywords must include letters or numbers.");
  if (terms.length > 12)
    throw new Error("Use at most 12 distinct search keywords.");
  return terms
    .map((term) => `"${term}"`)
    .join(match === "all" ? " AND " : " OR ");
}

export function journalMarkdown(date: string, entries: JournalEntry[]): string {
  const sections = entries.map((entry) => {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: entry.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(entry.occurred_at);
    return `## ${time} (${entry.timezone})\n\n${entry.content}`;
  });
  return `# Journal — ${date}\n\n${sections.length ? sections.join("\n\n") : "No journal entries."}\n`;
}

export class JournalStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY, source_message_id INTEGER NOT NULL UNIQUE,
      content TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL, timezone TEXT NOT NULL,
      local_date TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS journal_entries_day
      ON journal_entries (local_date, occurred_at, source_message_id)`);
    this.sql
      .exec(`CREATE VIRTUAL TABLE IF NOT EXISTS journal_entries_fts USING fts5(
      content, content='journal_entries', content_rowid='source_message_id',
      tokenize='porter unicode61 remove_diacritics 2'
    )`);
    // External-content indexing preserves the journal as the authoritative
    // original text. Triggers maintain the index in the same write transaction.
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS journal_entries_fts_insert
      AFTER INSERT ON journal_entries BEGIN
        INSERT INTO journal_entries_fts(rowid, content) VALUES (new.source_message_id, new.content);
      END`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS journal_entries_fts_delete
      AFTER DELETE ON journal_entries BEGIN
        INSERT INTO journal_entries_fts(journal_entries_fts, rowid, content)
          VALUES ('delete', old.source_message_id, old.content);
      END`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS journal_entries_fts_update
      AFTER UPDATE OF content, source_message_id ON journal_entries BEGIN
        INSERT INTO journal_entries_fts(journal_entries_fts, rowid, content)
          VALUES ('delete', old.source_message_id, old.content);
        INSERT INTO journal_entries_fts(rowid, content) VALUES (new.source_message_id, new.content);
      END`);
  }

  add(
    source: { message_id: number; text: string; created_at: number },
    timezone: string,
    occurredAt: string | null
  ): JournalEntry {
    // Keep the first successful capture across repeated tool calls, retries,
    // and inbox expiry. Never depend on model-generated text for identity.
    const existing = this.sql
      .exec<JournalEntry>(
        "SELECT * FROM journal_entries WHERE source_message_id = ?",
        source.message_id
      )
      .toArray()[0];
    if (existing) return existing;
    let occurred = source.created_at;
    if (occurredAt !== null) {
      if (!z.iso.datetime({ offset: true }).safeParse(occurredAt).success)
        throw new Error(
          "Use an ISO timestamp with Z or an explicit timezone offset."
        );
      occurred = new Date(occurredAt).getTime();
      if (occurred > Date.now())
        throw new Error(
          "Journal event times cannot be in the future. Record a current intention at the message time instead."
        );
    }
    const entry: JournalEntry = {
      id: `journal-${source.message_id}`,
      source_message_id: source.message_id,
      content: source.text,
      occurred_at: occurred,
      recorded_at: Date.now(),
      timezone,
      local_date: localDate(occurred, timezone)
    };
    this.sql.exec(
      `INSERT INTO journal_entries
        (id, source_message_id, content, occurred_at, recorded_at, timezone, local_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.source_message_id,
      entry.content,
      entry.occurred_at,
      entry.recorded_at,
      entry.timezone,
      entry.local_date
    );
    return entry;
  }

  day(date: string, limit?: number, offset = 0): JournalEntry[] {
    if (!validJournalDate(date))
      throw new Error("Use a valid date in YYYY-MM-DD format.");
    return this.sql
      .exec<JournalEntry>(
        `SELECT * FROM journal_entries WHERE local_date = ?
        ORDER BY occurred_at, source_message_id LIMIT ? OFFSET ?`,
        date,
        limit ?? -1,
        offset
      )
      .toArray();
  }

  search(input: JournalSearchInput) {
    const { query, match, fromDate, toDate, offset } =
      journalSearchInput.parse(input);
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];
    if (query !== null) {
      conditions.push("journal_entries_fts MATCH ?");
      bindings.push(searchExpression(query, match));
    }
    if (fromDate !== null) {
      conditions.push("e.local_date >= ?");
      bindings.push(fromDate);
    }
    if (toDate !== null) {
      conditions.push("e.local_date <= ?");
      bindings.push(toDate);
    }
    // Only fixed SQL fragments are interpolated. Every input value is bound.
    const excerpt =
      query === null
        ? "e.content"
        : "snippet(journal_entries_fts, 0, '', '', ' … ', 48)";
    const rows = this.sql
      .exec<
        Omit<JournalSearchEntry, "excerptTruncated"> & {
          excerpt_complete: number;
        }
      >(
        `SELECT e.id, e.source_message_id, e.occurred_at, e.recorded_at, e.timezone, e.local_date,
        substr(${excerpt}, 1, ${SEARCH_EXCERPT_LENGTH}) AS excerpt,
        (e.content = substr(${excerpt}, 1, ${SEARCH_EXCERPT_LENGTH})) AS excerpt_complete
       FROM ${query === null ? "journal_entries e" : "journal_entries_fts JOIN journal_entries e ON e.source_message_id = journal_entries_fts.rowid"}
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${query === null ? "" : "journal_entries_fts.rank, "}e.occurred_at DESC, e.source_message_id DESC
       LIMIT ? OFFSET ?`,
        ...bindings,
        SEARCH_PAGE_SIZE + 1,
        offset
      )
      .toArray();
    return {
      query,
      match,
      fromDate,
      toDate,
      entries: rows
        .slice(0, SEARCH_PAGE_SIZE)
        .map(({ excerpt_complete, ...entry }) => ({
          ...entry,
          excerptTruncated: !excerpt_complete
        })),
      nextOffset:
        rows.length > SEARCH_PAGE_SIZE ? offset + SEARCH_PAGE_SIZE : null
    };
  }
}
