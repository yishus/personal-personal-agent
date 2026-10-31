import type { JournalEntry } from "./journal.ts";

// A separate instance per owner gives a stronger boundary than a model-chosen
// metadata filter. Search results are resolved back to authoritative local rows.
export class JournalIndex {
  private sql: SqlStorage;
  private namespace: AiSearchNamespace | undefined;
  private ownerKey: string;
  constructor(
    sql: SqlStorage,
    namespace: AiSearchNamespace | undefined,
    ownerKey: string
  ) {
    this.sql = sql;
    this.namespace = namespace;
    this.ownerKey = ownerKey;
  }
  private async instanceName() {
    // Owner names can contain uppercase letters or exceed the provider's ID
    // length, so hash the full owner identity into a provider-safe instance ID.
    const hash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(this.ownerKey)
      )
    );
    return `journal-${Array.from(hash.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  initialize() {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS journal_index (entry_id TEXT PRIMARY KEY, uploaded INTEGER NOT NULL DEFAULT 0)"
    );
    this.sql
      .exec(`CREATE TRIGGER IF NOT EXISTS journal_index_insert AFTER INSERT ON journal_entries BEGIN
      INSERT OR IGNORE INTO journal_index (entry_id) VALUES (new.id);
    END`);
  }
  async sync() {
    if (!this.namespace)
      throw new Error("Configure the AI_SEARCH namespace binding first.");
    // This command is also a bounded backfill for entries captured before indexing.
    this.sql.exec(
      "INSERT OR IGNORE INTO journal_index (entry_id) SELECT id FROM journal_entries"
    );
    const name = await this.instanceName();
    const instance = this.namespace.get(name);
    try {
      await instance.info();
    } catch {
      await this.namespace.create({ id: name });
    }
    const entries = this.sql
      .exec<JournalEntry>(
        "SELECT e.* FROM journal_entries e JOIN journal_index i ON i.entry_id=e.id WHERE i.uploaded=0 ORDER BY e.source_message_id LIMIT 20"
      )
      .toArray();
    for (const entry of entries) {
      await instance.items.upload(
        `${entry.id}.md`,
        `# ${entry.local_date}\n\n${entry.content}\n\nCaptured: ${new Date(entry.occurred_at).toISOString()} (${entry.timezone})`
      );
      this.sql.exec(
        "UPDATE journal_index SET uploaded=1 WHERE entry_id=?",
        entry.id
      );
    }
    return {
      uploaded: entries.length,
      pending: this.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM journal_index WHERE uploaded=0"
        )
        .toArray()[0].count
    };
  }
  async search(query: string) {
    if (!this.namespace)
      return {
        error:
          "Semantic search is not configured. Use searchJournalEntries for immediate lexical search."
      };
    const result = await this.namespace.get(await this.instanceName()).search({
      messages: [{ role: "user", content: query }],
      ai_search_options: {
        retrieval: { max_num_results: 10 },
        cache: { enabled: false }
      }
    });
    const entries: JournalEntry[] = [];
    const seen = new Set<string>();
    for (const chunk of result.chunks ?? []) {
      const key = chunk.item?.key;
      if (!key || !/^journal-\d+\.md$/.test(key)) continue;
      const id = key.slice(0, -3);
      if (seen.has(id)) continue;
      const row = this.sql
        .exec<JournalEntry>("SELECT * FROM journal_entries WHERE id=?", id)
        .toArray()[0];
      if (row) {
        seen.add(id);
        entries.push({ ...row, content: row.content.slice(0, 4000) });
      }
    }
    return {
      trust: "historical_journal_data",
      entries,
      note: "Semantic indexing is asynchronous. Use lexical search for fresh entries or date filters."
    };
  }
}
