import { z } from "zod";

export type PublicResearchTurn = Readonly<{
  request: string;
  response?: string;
  findings?: string;
  verified?: true;
  status?: ResearchOutcome["status"];
}>;
export type ResearchMode = "search" | "answer";
export type ResearchContext = "new" | "follow_up";
export type PublicResearchTask = {
  instruction: string;
  sourceMessageId: number;
  context?: readonly PublicResearchTurn[];
  response?: string;
  findings?: string;
  responseVerified?: true;
  responseStatus?: ResearchOutcome["status"];
};

const MAX_PUBLIC_TURNS = 10;
const MAX_PUBLIC_CONTEXT_CHARS = 48_000;

// Keep only the conversation that actually went to the isolated researcher.
// Only the public reply composed by the main agent is retained. Private chat,
// journal, memory, credentials and unrelated main-agent replies never enter it.
export function publicResearchContext(
  task?: PublicResearchTask
): PublicResearchTurn[] {
  if (!task) return [];
  const context = [
    ...(task.context ?? []),
    {
      request: task.instruction,
      ...(task.response ? { response: task.response } : {}),
      ...(task.findings ? { findings: task.findings } : {}),
      ...(task.responseVerified ? { verified: true as const } : {}),
      ...(task.responseStatus ? { status: task.responseStatus } : {})
    }
  ];
  let characters = context.reduce(
    (total, turn) =>
      total +
      turn.request.length +
      (turn.response?.length ?? 0) +
      (turn.findings?.length ?? 0),
    0
  );
  while (
    context.length > MAX_PUBLIC_TURNS ||
    (characters > MAX_PUBLIC_CONTEXT_CHARS && context.length > 1)
  ) {
    const removed = context.shift()!;
    characters -=
      removed.request.length +
      (removed.response?.length ?? 0) +
      (removed.findings?.length ?? 0);
  }
  return context.map((turn) => ({ ...turn }));
}

export const researchOutputSchema = z.object({
  status: z
    .enum(["completed", "needs_clarification", "failed"])
    .describe(
      "completed: useful supported findings, including clearly labeled preliminary results. needs_clarification: an essential ambiguity prevents useful safe progress; missing optional preferences or a refinement question are not blockers. failed: research could not produce supported findings."
    ),
  report: z.string().trim().min(1).max(12_000)
});

export type ResearchOutcome = z.infer<typeof researchOutputSchema> & {
  trust: "untrusted_research_report";
  error?: string;
  verified?: true;
};

export function failedResearch(
  report: string,
  error = "research_unavailable"
): ResearchOutcome {
  return {
    trust: "untrusted_research_report",
    status: "failed",
    report,
    error
  };
}

// Only an explicit retry repeats the prior request. Other messages become the
// latest instruction with the public conversation available as reference data.
export function isResearchRetry(message: string): boolean {
  const text = message
    .toLowerCase()
    .replace(/[.!?,;—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:(?:sorry|please|ok|okay|yes|now|can you|could you|let's|lets) )*(?:retry(?: (?:it|that|the research|the search))?(?: again)?|try(?: (?:it|that|the research|the search))? (?:again|one more time)|(?:search|research) again)(?: (?:please|now))?$/.test(
    text
  );
}

export function resolveResearchTask(
  message: string,
  messageId: number,
  saved?: PublicResearchTask
): PublicResearchTask | null {
  if (isResearchRetry(message)) return saved ? { ...saved } : null;
  // Inbox recovery must not append a pending request to its own context.
  if (saved?.sourceMessageId === messageId && saved.instruction === message)
    return { ...saved };
  const context = publicResearchContext(saved);
  return {
    instruction: message,
    sourceMessageId: messageId,
    ...(context.length ? { context } : {})
  };
}

export class ResearchSession {
  readonly task: Readonly<PublicResearchTask> | null;
  private attempts = 0;
  private inFlight?: Promise<ResearchOutcome>;
  private mode: ResearchMode = "search";
  private selectedContext?: readonly PublicResearchTurn[];
  outcome?: ResearchOutcome;

  constructor(task: PublicResearchTask | null) {
    this.task = task
      ? Object.freeze({
          ...task,
          ...(task.context
            ? {
                context: Object.freeze(
                  task.context.map((turn) => Object.freeze({ ...turn }))
                )
              }
            : {})
        })
      : null;
  }

  get started() {
    return this.attempts > 0;
  }
  get context() {
    return this.selectedContext ?? this.task?.context ?? [];
  }
  get canRetry() {
    return (
      !!this.task &&
      this.attempts < 2 &&
      (!this.outcome || this.outcome.status === "failed")
    );
  }

  run(
    execute: (
      instruction: string,
      mode: ResearchMode
    ) => Promise<ResearchOutcome>,
    mode: ResearchMode = "search",
    context: ResearchContext = "follow_up"
  ): Promise<ResearchOutcome> {
    if (this.inFlight) return this.inFlight;
    if (!this.task)
      return Promise.resolve(
        (this.outcome = {
          trust: "untrusted_research_report",
          status: "needs_clarification",
          report:
            "What would you like me to research? Please repeat the research request."
        })
      );
    if (!this.canRetry)
      return Promise.resolve(
        this.outcome ??
          failedResearch("Research retry limit reached.", "retry_limit")
      );
    if (!this.started) {
      this.selectedContext = context === "new" ? [] : (this.task.context ?? []);
      // A new topic cannot borrow verification from an unrelated old report.
      this.mode = context === "new" ? "search" : mode;
    }
    this.attempts++;
    const instruction = this.task.instruction;
    this.inFlight = Promise.resolve()
      .then(() => execute(instruction, this.mode))
      .catch(() =>
        failedResearch("Research is unavailable. Please try again later.")
      )
      .then((outcome) => {
        this.outcome = outcome;
        this.inFlight = undefined;
        return outcome;
      });
    return this.inFlight;
  }
}
