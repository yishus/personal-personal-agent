import { z } from "zod";
import { validTimezone } from "./scheduling";

const goalId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goals.list") }),
  z.object({ type: z.literal("goals.get"), goalId }),
  z.object({
    type: z.literal("goals.update"),
    goalId,
    progress: z.string().trim().min(1).max(8000)
  }),
  z.object({
    type: z.literal("goals.control"),
    goalId,
    operation: z.enum(["pause", "resume", "cancel", "complete"])
  }),
  z.object({
    type: z.literal("goals.budget"),
    goalId,
    maxRuns: z.number().int().min(1).max(1000)
  }),
  z.object({
    type: z.literal("goals.deadline"),
    goalId,
    deadline: z.iso.datetime({ offset: true }).nullable()
  }),
  z.object({
    type: z.literal("goals.research"),
    goalId,
    publicBrief: z.string().trim().min(1).max(4000).nullable()
  }),
  z.object({ type: z.literal("approvals.list") }),
  z.object({
    type: z.literal("approvals.decide"),
    id: goalId,
    decision: z.enum(["approve", "reject"])
  }),
  z.object({ type: z.literal("tasks.list") }),
  z.object({ type: z.literal("tasks.cancel"), id: goalId }),
  z.object({
    type: z.literal("timezone.set"),
    timezone: z.string().refine(validTimezone)
  }),
  z.object({ type: z.literal("timezone.get") }),
  z.object({ type: z.literal("conversation.reset") }),
  z.object({ type: z.literal("journal.read"), date: z.iso.date().optional() }),
  z.object({
    type: z.literal("journal.export"),
    date: z.iso.date().optional()
  }),
  z.object({ type: z.literal("journal.index") }),
  z.object({
    type: z.literal("connector.control"),
    connector: z.enum(["calendar", "email"]),
    operation: z.enum(["connect", "disconnect"])
  }),
  z.object({ type: z.literal("help") })
]);
export type AgentAction = z.infer<typeof actionSchema>;

// Both API actions and chat commands enter the same durable inbox and execute
// the same application handlers, including approval and revocation checks.
export function actionText(action: AgentAction): string {
  switch (action.type) {
    case "goals.list":
      return "/goals";
    case "goals.get":
      return `/goal ${action.goalId}`;
    case "goals.update":
      return `/goal update ${action.goalId} ${action.progress}`;
    case "goals.control":
      return `/goal ${action.operation} ${action.goalId}`;
    case "goals.budget":
      return `/goal budget ${action.goalId} ${action.maxRuns}`;
    case "goals.deadline":
      return `/goal deadline ${action.goalId} ${action.deadline ?? "none"}`;
    case "goals.research":
      return `/goal research ${action.goalId} ${action.publicBrief ?? "off"}`;
    case "approvals.list":
      return "/approvals";
    case "approvals.decide":
      return `/${action.decision} ${action.id}`;
    case "tasks.list":
      return "/tasks";
    case "tasks.cancel":
      return `/cancel ${action.id}`;
    case "timezone.set":
      return `/timezone ${action.timezone}`;
    case "timezone.get":
      return "/timezone";
    case "conversation.reset":
      return "/reset";
    case "journal.read":
      return `/journal${action.date ? ` ${action.date}` : ""}`;
    case "journal.export":
      return `/journal export${action.date ? ` ${action.date}` : ""}`;
    case "journal.index":
      return "/journal index";
    case "connector.control":
      return `/${action.connector} ${action.operation}`;
    case "help":
      return "/help";
  }
}
