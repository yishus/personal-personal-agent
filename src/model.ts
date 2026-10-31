import { createWorkersAI } from "workers-ai-provider";
import { openai } from "workers-ai-provider/openai";

export interface GatewayEnv {
  AI: Ai;
  AI_GATEWAY_ID: string;
}

export function createGatewayModel(
  env: GatewayEnv,
  options: { sensitive?: boolean } = {}
) {
  if (!env.AI_GATEWAY_ID) {
    throw new Error(
      "Set the AI_GATEWAY_ID Worker secret with `pnpm exec wrangler secret put AI_GATEWAY_ID` (or in .dev.vars locally) to use your AI Gateway."
    );
  }

  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: env.AI_GATEWAY_ID },
    providers: [openai]
  });

  // The gateway injects its stored OpenRouter key. Do not enable `byok: true`,
  // which forwards provider credentials from this application instead.
  return workersai("openrouter/meta/muse-spark-open", {
    transport: "gateway",
    resume: false,
    ...(options.sensitive ? { collectLog: false, skipCache: true } : {})
  });
}
