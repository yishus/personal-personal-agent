import type { ToolSet } from "ai";

export function limitToolCalls<T extends ToolSet>(tools: T, limit: number): T {
  let calls = 0;
  for (const definition of Object.values(tools)) {
    const execute = definition.execute;
    if (execute)
      definition.execute = (...args) => {
        if (++calls > limit)
          throw new Error("Tool call budget exhausted for this run.");
        return execute(...args);
      };
  }
  return tools;
}

export class ExecutionLog {
  private sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS execution_log (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, tool TEXT NOT NULL,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      detail TEXT
    )`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS execution_log_recent ON execution_log(started_at DESC)`
    );
  }

  start(scope: string, tool: string, detail?: string) {
    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO execution_log (id, scope, tool, status, started_at, detail) VALUES (?, ?, ?, 'running', ?, ?)",
      id,
      scope,
      tool,
      Date.now(),
      detail?.slice(0, 1000) ?? null
    );
    return id;
  }

  finish(id: string, status: "completed" | "failed", detail?: string) {
    this.sql.exec(
      "UPDATE execution_log SET status = ?, finished_at = ?, detail = COALESCE(?, detail) WHERE id = ?",
      status,
      Date.now(),
      detail?.slice(0, 1000) ?? null,
      id
    );
  }

  recent() {
    return this.sql
      .exec<{
        id: string;
        tool: string;
        status: string;
        started_at: number;
        detail: string | null;
      }>(
        "SELECT id, tool, status, started_at, detail FROM execution_log ORDER BY started_at DESC LIMIT 20"
      )
      .toArray();
  }

  tools<T extends ToolSet>(scope: string, tools: T): T {
    for (const [name, definition] of Object.entries(tools)) {
      const execute = definition.execute;
      if (!execute) continue;
      definition.execute = async (...args) => {
        const id = this.start(scope, name);
        try {
          const result = await execute(...args);
          this.finish(
            id,
            result && typeof result === "object" && "error" in result
              ? "failed"
              : "completed"
          );
          return result;
        } catch (error) {
          // Provider exceptions can contain credential-bearing URLs.
          this.finish(id, "failed", "Execution failed.");
          throw error;
        }
      };
    }
    return tools;
  }
}

export type Approval = {
  id: string;
  kind: string;
  payload: string;
  status: string;
  created_at: number;
  expires_at: number;
  result: string | null;
};

export class ApprovalStore {
  private sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
  }
  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, result TEXT
    )`);
  }
  propose(id: string, kind: string, payload: unknown, ttlMs = 86400_000) {
    this.sql.exec(
      "INSERT OR IGNORE INTO approvals (id, kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      id,
      kind,
      JSON.stringify(payload),
      Date.now(),
      Date.now() + ttlMs
    );
    return this.get(id)!;
  }
  get(id: string) {
    return this.sql
      .exec<Approval>("SELECT * FROM approvals WHERE id = ?", id)
      .toArray()[0];
  }
  pending() {
    return this.sql
      .exec<Approval>(
        "SELECT * FROM approvals WHERE status IN ('pending', 'failed', 'executing') AND expires_at > ? ORDER BY created_at DESC LIMIT 20",
        Date.now()
      )
      .toArray();
  }
  claim(id: string) {
    // Claim synchronously before any network I/O. The approved bytes never change.
    return this.sql
      .exec<Approval>(
        "UPDATE approvals SET status = 'executing' WHERE id = ? AND (status = 'pending' OR (status = 'failed' AND kind != 'browser.interact')) AND expires_at > ? RETURNING *",
        id,
        Date.now()
      )
      .toArray()[0];
  }
  finish(id: string, result: string) {
    this.sql.exec(
      "UPDATE approvals SET status = 'completed', result = ? WHERE id = ? AND status = 'executing'",
      result,
      id
    );
  }
  fail(id: string) {
    this.sql.exec(
      "UPDATE approvals SET status = 'failed' WHERE id = ? AND status = 'executing'",
      id
    );
  }
  uncertain(id: string) {
    this.sql.exec(
      "UPDATE approvals SET status = 'uncertain', result = 'Browser outcome uncertain; inspect the page before proposing another action.' WHERE id = ? AND status = 'executing'",
      id
    );
  }
  reject(id: string) {
    return (
      this.sql
        .exec(
          "UPDATE approvals SET status = 'rejected' WHERE id = ? AND status IN ('pending', 'failed') RETURNING id",
          id
        )
        .toArray().length > 0
    );
  }
  recover() {
    // Browser effects cannot be replayed safely after an interrupted command.
    this.sql.exec(
      "UPDATE approvals SET status = 'uncertain', result = 'Browser execution interrupted; inspect the page before proposing another action.' WHERE kind = 'browser.interact' AND status = 'executing'"
    );
    // Other retryable action kinds can recover after an interrupted command.
    this.sql.exec(
      "UPDATE approvals SET status = 'failed' WHERE status = 'executing'"
    );
  }
}

export async function stableId(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
