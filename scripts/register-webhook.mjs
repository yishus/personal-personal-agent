const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const target = process.argv[2];

if (!token || !secret || !target) {
  console.error(
    "Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .dev.vars or the environment, then run: pnpm telegram:webhook https://your-worker.workers.dev"
  );
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error(
    "TELEGRAM_WEBHOOK_SECRET must contain 1–256 letters, digits, underscores, or hyphens."
  );
  process.exit(1);
}
const url = new URL("/telegram/webhook", target);
if (url.protocol !== "https:") {
  console.error("Telegram requires a public HTTPS URL.");
  process.exit(1);
}

const commands = [
  {
    command: "email",
    description:
      "Read-only Gmail: connect, status, ask; disconnect revokes Gmail + Calendar"
  },
  { command: "start", description: "Get started with your personal agent" },
  { command: "help", description: "Show commands and usage examples" },
  {
    command: "timezone",
    description: "View timezone; set with /timezone Asia/Singapore"
  },
  {
    command: "journal",
    description: "Read today's journal; supports export, index or YYYY-MM-DD"
  },
  {
    command: "calendar",
    description:
      "Read-only Calendar: connect; disconnect revokes Gmail + Calendar"
  },
  { command: "browser", description: "Close the browser with /browser close" },
  { command: "approvals", description: "Review proposed browser actions" },
  {
    command: "approve",
    description: "Approve a browser action with /approve ID"
  },
  {
    command: "reject",
    description: "Reject a proposed action with /reject ID"
  },
  { command: "log", description: "Show recent tool and task executions" },
  { command: "tasks", description: "List scheduled tasks and any issues" },
  { command: "goals", description: "List goals, their status and run budgets" },
  {
    command: "goal",
    description:
      "View or manage a goal: /goal ID, pause, resume, update or complete"
  },
  { command: "cancel", description: "Cancel a scheduled task with /cancel ID" },
  {
    command: "reset",
    description: "Clear chat history; keep journal, tasks and connections"
  }
];

async function register(method, payload, label) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000)
    }
  );
  const result = await response.json();
  if (!response.ok || !result.ok) {
    console.error(
      `Telegram rejected ${label} registration (${result.error_code ?? response.status}).`
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

let step = "webhook";
try {
  const webhookRegistered = await register(
    "setWebhook",
    {
      url: url.href,
      secret_token: secret,
      allowed_updates: ["message"],
      max_connections: 1
    },
    "webhook"
  );
  if (webhookRegistered) {
    console.log(`Webhook registered: ${url.href}`);
    step = "command menu";
    const commandsRegistered = await register(
      "setMyCommands",
      {
        commands,
        scope: { type: "all_private_chats" },
        language_code: ""
      },
      "command menu"
    );
    if (commandsRegistered)
      console.log(
        "Command menu registered for private chats. Type / in your bot chat to see suggestions."
      );
    else
      console.error(
        "The webhook is registered. Rerun this script to retry command menu registration."
      );
  }
} catch {
  // Network errors may include the token-bearing URL.
  console.error(
    `Could not register the ${step}. Check your connection and bot token, then rerun this script.`
  );
  process.exitCode = 1;
}
