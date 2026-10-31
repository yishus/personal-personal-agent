import type { ExecutionLog } from "./execution.ts";

export const MALFORMED_MODEL_REPLY =
  "The model returned an invalid tool response, so I couldn't finish this request. Please try again.";

// Detection only. Text that resembles a tool call is never executable input.
export function hasToolMarkup(text: string): boolean {
  return /<\s*\/?\s*atem:(?:function_calls|invoke|parameter)\b/i.test(text);
}

export function logMalformedResponse(
  log: ExecutionLog | undefined,
  scope: string
) {
  if (!log) return;
  const id = log.start(scope, "malformed_model_response");
  log.finish(id, "failed", "Model returned ATEM tool markup as text.");
}
