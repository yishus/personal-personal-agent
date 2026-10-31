import { z } from "zod";
import type { PublicResearchTurn } from "./research-session.ts";

export const goalInput = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4000),
  successCriteria: z.string().trim().min(1).max(2000),
  cadenceSeconds: z.number().int().min(60).max(31_536_000),
  maxRuns: z.number().int().min(1).max(1000),
  deadline: z.iso.datetime({ offset: true }).nullable(),
  publicResearch: z
    .boolean()
    .describe(
      "Enable only when the current user requests ongoing public research. The exact current message becomes the public brief; private updates are never shared with the researcher."
    )
});
export type GoalInput = z.infer<typeof goalInput>;
export type GoalStatus =
  | "active"
  | "waiting_user"
  | "paused"
  | "completed"
  | "cancelled"
  | "blocked"
  | "budget_exhausted"
  | "expired";
export type Goal = {
  id: string;
  destination_id: number;
  title: string;
  objective: string;
  success_criteria: string;
  instruction: string;
  public_brief: string | null;
  status: GoalStatus;
  revision: number;
  cadence_seconds: number;
  max_runs: number;
  runs_used: number;
  deadline_at: number | null;
  next_at: number | null;
  next_action: "review" | "research";
  progress_json: string | null;
  created_at: number;
  updated_at: number;
  failures: number;
  last_error: string | null;
};
export type GoalEvent = {
  id: string;
  goal_id: string;
  kind: string;
  content: string;
  created_at: number;
};
export type GoalStep = {
  goal_id: string;
  revision: number;
  status: string;
  started_at: number;
  research_json: string | null;
  output_json: string | null;
  sent_chunks: number;
};
export const goalResultSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  plan: z.array(z.string().trim().min(1).max(500)).max(8),
  nextAction: z.enum([
    "review",
    "research",
    "wait_user",
    "completion_candidate"
  ]),
  nextStep: z.string().trim().min(1).max(1000),
  message: z.string().trim().min(1).max(4000).nullable(),
  completionVerified: z.boolean().default(false),
  facts: z
    .array(
      z.object({ text: z.string().max(500), evidenceId: z.string().max(100) })
    )
    .max(20)
});
export type GoalResult = z.infer<typeof goalResultSchema>;
export type GoalResearch = {
  request: string;
  report: string;
  verified: boolean;
};

export class GoalStore {
  private sql: SqlStorage;
  private atomic: <T>(action: () => T) => T;
  constructor(sql: SqlStorage, atomic: <T>(action: () => T) => T) {
    this.sql = sql;
    this.atomic = atomic;
  }

  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, destination_id INTEGER NOT NULL, title TEXT NOT NULL,
      objective TEXT NOT NULL, success_criteria TEXT NOT NULL, instruction TEXT NOT NULL,
      public_brief TEXT, status TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 0,
      cadence_seconds INTEGER NOT NULL, max_runs INTEGER NOT NULL, runs_used INTEGER NOT NULL DEFAULT 0,
      deadline_at INTEGER, next_at INTEGER, next_action TEXT NOT NULL DEFAULT 'review', progress_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_steps (
      goal_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, research_json TEXT, output_json TEXT, sent_chunks INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (goal_id, revision)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_events (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS goal_events_history ON goal_events(goal_id)"
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS goals_wake ON goals(status, next_at)"
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS goal_steps_status ON goal_steps(status)"
    );
  }

  get(id: string) {
    return this.sql
      .exec<Goal>("SELECT * FROM goals WHERE id = ?", id)
      .toArray()[0];
  }
  all() {
    return this.sql
      .exec<Goal>("SELECT * FROM goals ORDER BY created_at DESC, id")
      .toArray();
  }
  wakeable() {
    return this.sql
      .exec<Goal>(
        "SELECT * FROM goals WHERE status = 'active' AND next_at IS NOT NULL ORDER BY next_at, id"
      )
      .toArray();
  }
  step(id: string, revision: number) {
    return this.sql
      .exec<GoalStep>(
        "SELECT * FROM goal_steps WHERE goal_id = ? AND revision = ?",
        id,
        revision
      )
      .toArray()[0];
  }
  events(id: string) {
    return this.sql
      .exec<GoalEvent>(
        "SELECT * FROM goal_events WHERE goal_id = ? ORDER BY rowid DESC LIMIT 20",
        id
      )
      .toArray()
      .reverse();
  }

  create(
    id: string,
    destinationId: number,
    instruction: string,
    raw: GoalInput,
    now = Date.now()
  ) {
    const existing = this.get(id);
    if (existing) return existing;
    const input = goalInput.parse(raw);
    const deadline = input.deadline ? Date.parse(input.deadline) : null;
    if (deadline !== null && deadline <= now)
      throw new Error("Goal deadline must be in the future.");
    this.sql.exec(
      `INSERT INTO goals (id, destination_id, title, objective, success_criteria, instruction, public_brief,
      cadence_seconds, max_runs, deadline_at, next_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      destinationId,
      input.title,
      input.objective,
      input.successCriteria,
      instruction,
      input.publicResearch ? instruction : null,
      input.cadenceSeconds,
      input.maxRuns,
      deadline,
      now + 1000,
      now,
      now
    );
    return this.get(id)!;
  }

  // Summaries omit research, generated plans and historical evidence so listing
  // goals does not expose the private assistant to external instructions.
  summary(goal: Goal) {
    return {
      id: goal.id,
      title: goal.title,
      objective: goal.objective,
      successCriteria: goal.success_criteria,
      status: goal.status,
      nextAt: goal.next_at,
      cadenceSeconds: goal.cadence_seconds,
      runsUsed: goal.runs_used,
      maxRuns: goal.max_runs,
      deadline: goal.deadline_at,
      publicResearch: goal.public_brief !== null,
      lastError: goal.last_error
    };
  }

  private requireMutable(id: string) {
    const goal = this.get(id);
    if (!goal) throw new Error("Goal not found. Use /goals.");
    if (["completed", "cancelled"].includes(goal.status))
      throw new Error("This goal has ended. Create a new goal to continue.");
    return goal;
  }

  private invalidate(id: string) {
    this.sql.exec(
      "UPDATE goal_steps SET status = 'superseded' WHERE goal_id = ? AND status IN ('running', 'retry', 'ready')",
      id
    );
  }

  private runnable(goal: Goal, now: number): GoalStatus {
    if (goal.deadline_at !== null && goal.deadline_at <= now) return "expired";
    return goal.runs_used >= goal.max_runs ? "budget_exhausted" : "active";
  }

  update(id: string, eventId: string, text: string, now = Date.now()) {
    const content = z.string().trim().min(1).max(8000).parse(text);
    return this.atomic(() => {
      const goal = this.requireMutable(id);
      if (
        this.sql
          .exec("SELECT id FROM goal_events WHERE id = ?", eventId)
          .toArray().length
      )
        return goal;
      const status =
        goal.status === "paused" ? "paused" : this.runnable(goal, now);
      this.invalidate(id);
      this.sql.exec(
        "INSERT INTO goal_events VALUES (?, ?, 'user', ?, ?)",
        eventId,
        id,
        content,
        now
      );
      this.sql.exec(
        "UPDATE goals SET revision = revision + 1, status = ?, next_at = ?, failures = 0, last_error = NULL, updated_at = ? WHERE id = ?",
        status,
        status === "active" ? now + 1000 : null,
        now,
        id
      );
      return this.get(id)!;
    });
  }

  control(
    id: string,
    action: "pause" | "resume" | "cancel" | "complete",
    eventId: string,
    now = Date.now()
  ) {
    return this.atomic(() => {
      const goal = this.get(id);
      if (!goal) throw new Error("Goal not found. Use /goals.");
      if (
        this.sql
          .exec("SELECT id FROM goal_events WHERE id = ?", eventId)
          .toArray().length
      )
        return goal;
      if (
        goal.status === "cancelled" ||
        (goal.status === "completed" && action !== "resume")
      )
        return goal;
      if (
        action === "resume" &&
        goal.status === "blocked" &&
        this.step(id, goal.revision)?.status === "ready" &&
        (goal.deadline_at === null || goal.deadline_at > now)
      ) {
        // Delivery exhausted its retry limit, but the already-computed result
        // needs no new inference budget and has not been invalidated by input.
        this.sql.exec(
          "INSERT INTO goal_events VALUES (?, ?, 'control', ?, ?)",
          eventId,
          id,
          action,
          now
        );
        this.sql.exec(
          "UPDATE goals SET status = 'active', next_at = ?, failures = 0, last_error = NULL, updated_at = ? WHERE id = ?",
          now + 1000,
          now,
          id
        );
        return this.get(id)!;
      }
      const status =
        action === "resume"
          ? this.runnable(goal, now)
          : action === "pause"
            ? "paused"
            : action === "cancel"
              ? "cancelled"
              : "completed";
      this.invalidate(id);
      this.sql.exec(
        "INSERT INTO goal_events VALUES (?, ?, 'control', ?, ?)",
        eventId,
        id,
        action,
        now
      );
      this.sql.exec(
        "UPDATE goals SET status = ?, revision = revision + 1, next_at = ?, failures = 0, last_error = NULL, updated_at = ? WHERE id = ?",
        status,
        status === "active" ? now + 1000 : null,
        now,
        id
      );
      return this.get(id)!;
    });
  }

  configure(
    id: string,
    eventId: string,
    change: {
      maxRuns?: number;
      deadline?: number | null;
      publicBrief?: string | null;
    },
    now = Date.now()
  ) {
    return this.atomic(() => {
      const goal = this.requireMutable(id);
      if (
        this.sql
          .exec("SELECT id FROM goal_events WHERE id = ?", eventId)
          .toArray().length
      )
        return goal;
      const maxRuns = z
        .number()
        .int()
        .min(1)
        .max(1000)
        .parse(change.maxRuns ?? goal.max_runs);
      if (maxRuns < goal.runs_used)
        throw new Error("Run budget cannot be smaller than runs already used.");
      const deadline =
        change.deadline === undefined ? goal.deadline_at : change.deadline;
      if (deadline !== null && (!Number.isFinite(deadline) || deadline <= now))
        throw new Error("Use a future deadline or none.");
      const brief =
        change.publicBrief === undefined
          ? goal.public_brief
          : change.publicBrief;
      if (brief !== null) z.string().trim().min(1).max(8000).parse(brief);
      const status =
        goal.status === "paused"
          ? "paused"
          : this.runnable(
              { ...goal, max_runs: maxRuns, deadline_at: deadline },
              now
            );
      this.invalidate(id);
      this.sql.exec(
        "INSERT INTO goal_events VALUES (?, ?, 'control', ?, ?)",
        eventId,
        id,
        change.publicBrief !== undefined
          ? "Public research scope updated."
          : "Run budget or deadline updated.",
        now
      );
      this.sql.exec(
        `UPDATE goals SET max_runs = ?, deadline_at = ?, public_brief = ?, status = ?, revision = revision + 1,
        next_action = 'review', next_at = ?, failures = 0, last_error = NULL, updated_at = ? WHERE id = ?`,
        maxRuns,
        deadline,
        brief,
        status,
        status === "active" ? now + 1000 : null,
        now,
        id
      );
      return this.get(id)!;
    });
  }

  claim(id: string, revision: number, now = Date.now()) {
    return this.atomic(() => {
      let goal = this.get(id);
      if (
        !goal ||
        goal.status !== "active" ||
        goal.revision !== revision ||
        goal.next_at === null
      )
        return null;
      if (goal.deadline_at !== null && goal.deadline_at <= now) {
        this.sql.exec(
          "UPDATE goals SET status = 'expired', next_at = NULL, updated_at = ? WHERE id = ?",
          now,
          id
        );
        return null;
      }
      if (goal.next_at > now) return null;
      const step = this.step(id, revision);
      if (step?.status === "ready") return { goal, step };
      if (step && step.status !== "retry") return null;
      if (goal.runs_used >= goal.max_runs) {
        this.sql.exec(
          "UPDATE goals SET status = 'budget_exhausted', next_at = NULL, updated_at = ? WHERE id = ?",
          now,
          id
        );
        return null;
      }
      this.sql.exec(
        "UPDATE goals SET runs_used = runs_used + 1, updated_at = ? WHERE id = ?",
        now,
        id
      );
      this.sql.exec(
        `INSERT INTO goal_steps (goal_id, revision, status, started_at) VALUES (?, ?, 'running', ?)
        ON CONFLICT(goal_id, revision) DO UPDATE SET status = 'running', started_at = excluded.started_at`,
        id,
        revision,
        now
      );
      goal = this.get(id)!;
      return { goal, step: this.step(id, revision)! };
    });
  }

  current(id: string, revision: number) {
    const goal = this.get(id);
    return goal?.status === "active" && goal.revision === revision;
  }

  expire(id: string, now = Date.now()) {
    const goal = this.get(id);
    if (
      goal?.status === "active" &&
      goal.deadline_at !== null &&
      goal.deadline_at <= now
    ) {
      this.atomic(() => {
        this.invalidate(id);
        this.sql.exec(
          "UPDATE goals SET status = 'expired', next_at = NULL, updated_at = ? WHERE id = ?",
          now,
          id
        );
      });
    }
  }

  cacheResearch(id: string, revision: number, report: GoalResearch) {
    if (!this.current(id, revision)) return false;
    return (
      this.sql
        .exec(
          "UPDATE goal_steps SET research_json = ? WHERE goal_id = ? AND revision = ? AND status = 'running' RETURNING goal_id",
          JSON.stringify(report),
          id,
          revision
        )
        .toArray().length > 0
    );
  }

  cache(id: string, revision: number, raw: GoalResult) {
    const result = goalResultSchema.parse(raw);
    if (!this.current(id, revision)) return false;
    return (
      this.sql
        .exec(
          "UPDATE goal_steps SET output_json = ?, status = 'ready' WHERE goal_id = ? AND revision = ? AND status = 'running' RETURNING goal_id",
          JSON.stringify(result),
          id,
          revision
        )
        .toArray().length > 0
    );
  }

  checkpoint(id: string, revision: number, sent: number) {
    if (this.current(id, revision))
      this.sql.exec(
        "UPDATE goal_steps SET sent_chunks = ? WHERE goal_id = ? AND revision = ? AND status = 'ready'",
        sent,
        id,
        revision
      );
  }

  finish(id: string, revision: number, now = Date.now()) {
    return this.atomic(() => {
      if (!this.current(id, revision)) return false;
      const goal = this.get(id)!,
        step = this.step(id, revision);
      if (step?.status !== "ready" || !step.output_json) return false;
      const result = goalResultSchema.parse(JSON.parse(step.output_json));
      const completed =
        result.nextAction === "completion_candidate" &&
        result.completionVerified;
      const waiting = ["wait_user", "completion_candidate"].includes(
        result.nextAction
      );
      const status = completed
        ? "completed"
        : waiting
          ? "waiting_user"
          : this.runnable(goal, now);
      this.sql.exec(
        "UPDATE goal_steps SET status = 'completed' WHERE goal_id = ? AND revision = ?",
        id,
        revision
      );
      this.sql.exec(
        "INSERT OR IGNORE INTO goal_events VALUES (?, ?, 'runner', ?, ?)",
        `${id}:run:${revision}`,
        id,
        step.output_json,
        now
      );
      this.sql.exec(
        `UPDATE goals SET progress_json = ?, status = ?, next_at = ?, next_action = ?, revision = revision + 1,
        failures = 0, last_error = NULL, updated_at = ? WHERE id = ?`,
        step.output_json,
        status,
        status === "active" ? now + goal.cadence_seconds * 1000 : null,
        result.nextAction === "research" ? "research" : "review",
        now,
        id
      );
      return true;
    });
  }

  fail(
    id: string,
    revision: number,
    delivery = false,
    retrySeconds = 900,
    permanent = false,
    now = Date.now()
  ) {
    return this.atomic(() => {
      if (!this.current(id, revision)) return;
      const goal = this.get(id)!,
        step = this.step(id, revision);
      const failures = goal.failures + 1;
      let status = this.runnable(goal, now);
      // A cached result can still be delivered without spending another run.
      if (status === "budget_exhausted" && step?.status === "ready")
        status = "active";
      if ((permanent || failures >= 3) && status === "active")
        status = "blocked";
      this.sql.exec(
        "UPDATE goal_steps SET status = CASE WHEN status = 'running' THEN 'retry' ELSE status END WHERE goal_id = ? AND revision = ?",
        id,
        revision
      );
      this.sql.exec(
        "UPDATE goals SET failures = ?, status = ?, next_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
        failures,
        status,
        status === "active" ? now + Math.max(1, retrySeconds) * 1000 : null,
        delivery
          ? "Goal notification delivery failed."
          : "Goal step failed; progress retained.",
        now,
        id
      );
    });
  }

  recover() {
    for (const step of this.sql
      .exec<GoalStep>("SELECT * FROM goal_steps WHERE status = 'running'")
      .toArray())
      this.fail(step.goal_id, step.revision);
  }

  publicContext(goal: Goal): PublicResearchTurn[] {
    // Only research from the current explicitly authorized brief crosses back
    // into the isolated researcher. User updates and private plans never do.
    return this.sql
      .exec<{ research_json: string }>(
        "SELECT research_json FROM goal_steps WHERE goal_id = ? AND research_json IS NOT NULL ORDER BY revision DESC LIMIT 5",
        goal.id
      )
      .toArray()
      .reverse()
      .map((row) => JSON.parse(row.research_json) as GoalResearch)
      .filter((item) => item.request === goal.public_brief && item.verified)
      .map((item) => ({
        request: item.request,
        findings: item.report,
        response: item.report,
        verified: true as const
      }));
  }

  researchEvidence(goal: Goal) {
    return this.sql
      .exec<{ revision: number; research_json: string }>(
        "SELECT revision, research_json FROM goal_steps WHERE goal_id = ? AND research_json IS NOT NULL ORDER BY revision DESC LIMIT 3",
        goal.id
      )
      .toArray()
      .reverse()
      .map((row) => ({
        revision: row.revision,
        research: JSON.parse(row.research_json) as GoalResearch
      }))
      .filter(
        (item) =>
          item.research.request === goal.public_brief && item.research.verified
      )
      .map((item) => ({
        id: `research:${item.revision}`,
        source: "research" as const,
        text: item.research.report
      }));
  }
}

export function goalDetail(goal: Goal, events: GoalEvent[]) {
  const progress = goal.progress_json
    ? goalResultSchema.parse(JSON.parse(goal.progress_json))
    : null;
  return [
    `${goal.title}\nID: ${goal.id}\nStatus: ${goal.status}`,
    `Objective: ${goal.objective}\nSuccess: ${goal.success_criteria}`,
    `Runs: ${goal.runs_used}/${goal.max_runs}\nCadence: ${goal.cadence_seconds} seconds\nNext: ${goal.next_at ? new Date(goal.next_at).toISOString() : "Waiting or stopped"}\nDeadline: ${goal.deadline_at ? new Date(goal.deadline_at).toISOString() : "None"}\nPublic research: ${goal.public_brief ?? "Off"}`,
    ...(progress
      ? [
          `Progress: ${progress.summary}\nPlan:\n${progress.plan.map((item) => `• ${item}`).join("\n")}\nNext step: ${progress.nextStep}`
        ]
      : []),
    ...events
      .filter((event) => event.kind === "user")
      .slice(-3)
      .map((event) => `Your update: ${event.content}`),
    ...(goal.last_error ? [goal.last_error] : []),
    `/goal update ${goal.id} <progress or answer>\n/goal pause ${goal.id}\n/goal resume ${goal.id}\n/goal complete ${goal.id}\n/goal cancel ${goal.id}\n/goal budget ${goal.id} <new total runs>\n/goal deadline ${goal.id} <ISO timestamp or none>\n/goal research ${goal.id} <public request or off>`
  ].join("\n\n");
}
