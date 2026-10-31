export const JOB_RETENTION_MS = 7 * 86400_000;
export const CLEANUP_BATCH_SIZE = 500;

export const JOBS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS inbox_jobs (
  message_id INTEGER PRIMARY KEY, destination_id INTEGER NOT NULL, text TEXT NOT NULL,
  reply TEXT, reply_filename TEXT, sent_chunks INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  notice_attempted INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  conversation_id TEXT NOT NULL, sensitive_reply_expires INTEGER,
  provider_message_id TEXT, reply_kind TEXT NOT NULL DEFAULT 'text'
)`;

export function initializeInbox(sql: SqlStorage) {
  sql.exec(JOBS_TABLE_SQL);
  // Additive migration preserves pending jobs on existing deployments.
  const columns = new Set(
    sql
      .exec<{ name: string }>("PRAGMA table_info(inbox_jobs)")
      .toArray()
      .map((column) => column.name)
  );
  if (!columns.has("provider_message_id"))
    sql.exec("ALTER TABLE inbox_jobs ADD COLUMN provider_message_id TEXT");
  if (!columns.has("reply_kind"))
    sql.exec(
      "ALTER TABLE inbox_jobs ADD COLUMN reply_kind TEXT NOT NULL DEFAULT 'text'"
    );
  sql.exec(JOBS_INDEX_SQL);
}

// One index supports FIFO selection, pending existence checks, and expiry.
// Do not index reply/checkpoint fields: they change on every delivery attempt.
export const JOBS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS inbox_jobs_status_created
  ON inbox_jobs (done, created_at, message_id)`;

export const NEXT_JOB_SQL = `SELECT * FROM inbox_jobs WHERE done = 0
  ORDER BY created_at, message_id LIMIT 1`;

// The subquery bounds deletion work even after a long inactive period.
export const PRUNE_JOBS_SQL = `DELETE FROM inbox_jobs WHERE message_id IN (
  SELECT message_id FROM inbox_jobs WHERE done = 1 AND created_at < ?
  ORDER BY created_at, message_id LIMIT ?
)`;
