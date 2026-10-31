import type { ToolSet } from "ai";
import type { ExecutionLog } from "./execution.ts";

export const SOURCE_TOOLS = [
  "web_search",
  "web_fetch",
  "browser_run",
  "browser_open",
  "browser_read",
  "browser_scroll"
] as const;

// These counters are updated by actual tool execution, including calls nested
// inside Code Mode. Model output and saved prose cannot mark evidence verified.
export class ResearchEvidence {
  attempts = 0;
  successes = 0;
  searchCalls = 0;
  pageReadAttempts = 0;
  pageReads = 0;
  proposalCreated = false;
  private failureCode?: string;
  private readonly log?: ExecutionLog;
  private readonly scope: string;
  private readonly signal?: AbortSignal;

  constructor(log?: ExecutionLog, scope = "research", signal?: AbortSignal) {
    this.log = log;
    this.scope = scope;
    this.signal = signal;
  }

  track<T extends ToolSet>(tools: T): T {
    for (const [name, definition] of Object.entries(tools)) {
      const execute = definition.execute;
      const source = (SOURCE_TOOLS as readonly string[]).includes(name);
      if (!execute || (!source && name !== "browser_interact")) continue;
      definition.execute = async (...args) => {
        if (source) {
          this.attempts++;
          if (name === "web_search") this.searchCalls++;
          else this.pageReadAttempts++;
        }
        try {
          // Code Mode invokes RPC tools with input only. Cloudflare's AI SDK
          // adapters also require ToolExecutionOptions, even for read-only calls.
          const result = await execute(
            args[0],
            args[1] ?? {
              toolCallId: `research-${crypto.randomUUID()}`,
              messages: [],
              abortSignal: this.signal
            }
          );
          if (result && typeof result === "object" && "error" in result) {
            if (source) this.recordFailure(name);
          } else if (source) {
            this.successes++;
            if (name !== "web_search") this.pageReads++;
          } else if (
            result &&
            typeof result === "object" &&
            "approvalId" in result
          )
            this.proposalCreated = true;
          return result;
        } catch (error) {
          if (source) this.recordFailure(name, error);
          throw error;
        }
      };
    }
    return tools;
  }

  progress() {
    return `Research progress for this run (host-observed tool activity): search_calls=${this.searchCalls}; page_read_attempts=${this.pageReadAttempts}; successful_page_reads=${this.pageReads}.
${
  this.searchCalls >= 3
    ? "Several discovery searches have already run. Review their results and read the best existing source URLs before considering another search. If the requested answer is supported, finishResearch now; otherwise search only for a specific missing requirement."
    : "Prefer reading the useful source URLs already found. Search again only for a specific gap, not to repeat discovery with synonyms."
}
These counts do not establish factual coverage or source quality. Report remaining uncertainty rather than inventing verification.`;
  }

  private recordFailure(name: string, error?: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    // Record only known machine codes, never provider messages, URLs or bodies.
    const safeCode =
      typeof code === "string" &&
      /^(?:invalid_)?web_(?:search|fetch)_[a-z_]{1,64}$/.test(code)
        ? code
        : "source_tool_failed";
    if (safeCode !== "source_tool_failed" || !this.failureCode)
      this.failureCode = safeCode;
    if (this.log) {
      const id = this.log.start(this.scope, "research_source_failure");
      this.log.finish(id, "failed", `${name}: ${safeCode}`);
    }
  }

  failureReport() {
    switch (this.failureCode) {
      case "web_search_payment_required":
        return "Web search needs AI Gateway credits or a configured search-provider key.";
      case "web_search_byok_not_configured":
        return "The configured web-search provider key is missing from AI Gateway.";
      case "web_search_gateway_not_configured":
        return "The AI Gateway for web search is not configured.";
      case "web_search_unauthorized":
        return "AI Gateway rejected the web-search credentials.";
      case "web_search_unsupported_runtime":
        return "This Workers runtime does not support the web-search binding.";
      case "web_search_rate_limited":
        return "Web search is temporarily rate limited. Please try again later.";
      default:
        return this.attempts
          ? "The research tools did not return usable sources. Please try again later."
          : "The model did not run a research tool, so this research was not completed. Please try again.";
    }
  }
}
