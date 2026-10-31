# _personal_ Personal Agent

> We have muse at home.

Personal personal agent allows you to run your own personal agent, mostly on Cloudflare infrastructure. Out of the box Telegram is supported as a channel and allow more channels to be integrated eg. web, WhatsApp.

## Examples:

- “Starting the proposal. I'm feeling distracted.” Automatically journals the original message as one entry. Intentions remain intentions, and explicit requests not to journal are respected.
- “When did I feel overwhelmed about work?” Uses semantic retrieval after `/journal index`, with original journal entries as evidence. Exact keywords and date ranges remain available immediately through local search.
- “Remember that I prefer morning meetings.” Saves a durable preference. “Forget my meeting preference” removes it.
- “What's on my calendar tomorrow?” Reads the connected primary calendar.
- “Add a focus block tomorrow from 9 to 10.” Sends an .ics draft to review and import; requires no Google connection.
- “Summarize Alex's emails from this week and suggest a reply to the latest one.” Searches the connected Gmail account after `/email connect` and returns a summary and suggested reply text for manual sending.
- “Research these five products and compare them.” Delegates public research without private context.
- “Open https://example.com/contact, fill Name with Alex and Message with ‘Please send a brochure’, then click Send.” Inspects the page and proposes the exact fields and final click; `/approve ID` performs the interactions.
- “Scroll down in the browser.” Continues the active browser while its session is alive.
- “Track these five product URLs daily and tell me which becomes cheapest.” Uses the common scheduler with a deterministic lowest-price condition.
- “Track this product URL daily and tell me when its price drops 20%.” Establishes a baseline on the first successful check, then compares against that original price on every later check.
- “Send me the top ten Hacker News posts daily.” Schedules a public digest.

## Primitives

| Primitive                  | Implementation                                  | Behavior                                                                                                                              |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Code Mode                  | `@cloudflare/codemode`, Worker Loader           | Typed tool composition in an isolated Worker; direct outbound network disabled. Every nested tool still enforces its access checks.   |
| Web fetch                  | `agents/webfetch`                               | Cloudflare document conversion, bounded text, request deadlines, public destinations and redirect checks.                             |
| Browser Run                | `agents/browser`                                | Render pages, or keep a per-owner interactive session for inspection/scrolling and approved clicks, field filling and selection.      |
| Web search                 | `agents/websearch`                              | Cloudflare Web Search through AI Gateway, with a bounded result count.                                                                |
| Typed extraction           | Workers AI Clairic                              | Extract typed values, dates, lists and estimates from supplied text, with nulls and confidence metadata.                              |
| Structured decisions       | Workers AI Clef                                 | Classify, score and make focused yes/no judgments with probabilities.                                                                 |
| Google Calendar            | Per-user OAuth connector                        | Read primary-calendar events with read-only OAuth; send .ics event drafts for manual import.                                          |
| Email (Gmail)              | Per-user OAuth connector and isolated reader    | Search and read Gmail with read-only OAuth; summarize messages and suggest reply text for manual sending.                             |
| MCP                        | Agents SDK MCP client and isolated tool session | Remote tools configured through REST with owner-scoped `mcp:manage` access; persistent connections, authentication headers and OAuth. |
| Approval and execution log | SQLite action records and tool wrappers         | Frozen browser action payloads, expiry, reject/approve commands, and durable execution outcomes.                                      |
| Goals                      | SQLite state, bounded runner and Agents alarms  | Persistent objectives, progress, private updates, read-only research, run budgets, pause/resume and evidence-supported completion.    |
| Scheduled tasks            | Agents alarms and SQLite checkpoints            | One-off, relative, local cron and interval schedules; background research, retries and cached notification delivery.                  |
| Memory                     | SQLite facts and preferences                    | Explicit remember, recall, expiry and forget operations; separate from the activity journal.                                          |
| Journal search             | SQLite FTS5 plus optional AI Search             | Immediate lexical/date search and asynchronous semantic retrieval from a separate AI Search instance per owner.                       |

## Interfaces

Use the HTTP API, Telegram, or both. Telegram is optional and only needs to be configured if you want to use it.

See [Channels and the HTTP API](docs/channels.md) for setup, curl examples, structured actions, retention, and instructions for adding an adapter.

Remote MCP connections are configured through `POST /api/mcp/servers`, with authenticated list/inspect/delete endpoints. Only API tokens explicitly granted `permissions: ["mcp:manage"]` can administer connections; ordinary tokens are denied by default. Public servers, authentication headers, Streamable HTTP/SSE, and browser-based OAuth are supported. The bot can use the connected tools in an isolated session; setup and removal stay in REST. See [MCP setup and access control](docs/channels.md#manage-mcp-connections).

## Deploy to Cloudflare

This deploys a fresh Worker and its SQLite-backed Durable Objects. You need Node.js 22.18+, pnpm, a [Cloudflare account](https://dash.cloudflare.com/), and provider accounts for OpenRouter and Exa. A custom domain is optional; the deployed `workers.dev` URL works with both interfaces.

### 1. Prepare the project

From the repository root, run:

```bash
pnpm install
cp wrangler.jsonc.example wrangler.jsonc
cp .dev.vars.example .dev.vars
pnpm exec wrangler login
pnpm exec wrangler whoami
```

### 2. Configure AI Gateway and provider keys

In the same Cloudflare account, go to **AI → AI Gateway** and [create a gateway](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/). Enable gateway authentication for [stored provider keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/), then add these under **Provider Keys**:

| Provider   | Key alias | Used for                                        |
| ---------- | --------- | ----------------------------------------------- |
| OpenRouter | `default` | Chat and research using `meta/muse-spark-open`. |
| Exa        | `default` | Web search.                                     |

Update `AT_GATEWAY_ID` in `.dev.vars` with the gateway ID set in this step.

### 3. Review Configuration

The template already declares the bindings used by the application:

| Binding     | Cloudflare resource | Purpose                                                                     |
| ----------- | ------------------- | --------------------------------------------------------------------------- |
| `AI`        | Workers AI          | Gateway model calls, web search, document conversion, and typed extraction. |
| `ChatAgent` | Durable Object      | Per-owner storage, inbox processing, goals, and task alarms.                |
| `BROWSER`   | Browser Run         | Render pages and perform approved browser interactions.                     |
| `AI_SEARCH` | AI Search namespace | Optional semantic journal indexing and search.                              |

`AI_SEARCH` points to the account's automatically created [`default` namespace](https://developers.cloudflare.com/ai-search/concepts/namespaces/). The agent creates an instance per owner when `/journal index` is used. To use a separate namespace, [create one](https://developers.cloudflare.com/ai-search/wrangler-commands/) and update `ai_search_namespaces[].namespace` in `wrangler.jsonc`. Ordinary journal storage and lexical search do not require semantic indexing.

Code Mode is optional and disabled in the template. To enable it, use a [Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/) and uncomment this property in `wrangler.jsonc`:

```jsonc
"worker_loaders": [{ "binding": "LOADER" }],
```

### 4. Create the Worker and Durable Object namespace

```bash
pnpm types
pnpm check
pnpm exec wrangler deploy --dry-run
pnpm deploy
pnpm exec wrangler secret put AI_GATEWAY_ID
```

```bash
curl --fail https://personal-personal-agent.YOUR-SUBDOMAIN.workers.dev/health
```

Expect `ok`.

### 5. Configure your interfaces

Configure at least one of the following interfaces. You can enable both on the same Worker.

#### HTTP API (optional)

If you want to use the HTTP API, generate a token with `openssl rand -hex 32`, then follow [account and token configuration](docs/channels.md#http-only-setup) to prepare the `API_ACCOUNTS` JSON. Upload it to the Worker:

```bash
pnpm exec wrangler secret put API_ACCOUNTS
```

For local development, also add `API_ACCOUNTS` to `.dev.vars` as shown in that guide. If you only want the HTTP API, skip the Telegram section and continue to step 7.

#### Telegram setup (optional)

Only complete this section if you want to use Telegram. An HTTP-only deployment needs no Telegram bot, secrets, or webhook. The Cloudflare login, configuration files, Worker, and gateway are already set up by the preceding steps.

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`. Choose a name and username, then copy the bot token. See Telegram's [bot creation guide](https://core.telegram.org/bots/features#creating-a-new-bot).

2. Generate a separate webhook secret with `openssl rand -hex 32`. Determine your numeric Telegram user ID, then add these values to the existing `.dev.vars` file:

   ```dotenv
   TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
   TELEGRAM_WEBHOOK_SECRET=your-generated-hex-secret
   TELEGRAM_ALLOWED_USER_IDS=123456789
   ```

   For multiple users, use comma-separated numeric IDs in `TELEGRAM_ALLOWED_USER_IDS`.

3. Upload the Telegram production secrets. Paste the corresponding value from `.dev.vars` at each prompt:

   ```bash
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
   pnpm exec wrangler secret put TELEGRAM_ALLOWED_USER_IDS
   ```

4. Register the deployed Worker URL, replacing the example below with the HTTPS URL printed in step 4:

   ```bash
   pnpm telegram:webhook https://personal-personal-agent.YOUR-SUBDOMAIN.workers.dev
   ```

   The script reads the bot token and webhook secret from `.dev.vars` or your shell environment. It registers `/telegram/webhook` and the bot's command menu. The webhook secret must match the value uploaded to Cloudflare.

5. Send `/start` to your bot, then set your timezone, for example `/timezone Asia/Singapore`. Type `/` to see available commands.

If the bot does not reply, check that `https://YOUR-WORKER/health` returns `ok`, your numeric user ID is allowlisted, and the local and deployed webhook secrets match. Rerun `pnpm telegram:webhook https://YOUR-WORKER` whenever the Worker URL or webhook secret changes.

### 7. Verify the agent

Send a normal chat request and a web research request through your chosen interface to verify both model and search credentials. For the HTTP API, see [submitting a message](docs/channels.md#submit-a-message) and [reading replies](docs/channels.md#read-replies-and-notifications). The first message invokes the owner's `ChatAgent` object.

For deployment or request errors, inspect the terminal output and live logs:

```bash
pnpm exec wrangler tail
```

Run `pnpm deploy` again to publish later code changes to the same Worker. Rerun `pnpm types` whenever bindings change.

Google Calendar and Gmail are optional. Their shared OAuth credentials, signing secrets, and authorized redirect URLs are listed in [.dev.vars.example](.dev.vars.example). Set `PUBLIC_BASE_URL` to the deployed Worker's HTTPS origin when enabling those connectors.

## Commands and examples

| Command                                      | Behavior                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `/timezone Asia/Singapore`                   | Save an IANA timezone; omit the argument to inspect it.                           |
| `/journal [YYYY-MM-DD]`                      | Read a day; default to today in the saved timezone, or UTC.                       |
| `/journal export [YYYY-MM-DD]`               | Send a day's Markdown document.                                                   |
| `/journal index`                             | Enable semantic indexing and backfill existing journal entries.                   |
| `/calendar connect` / `/calendar disconnect` | Manage the read-only Google Calendar connection.                                  |
| `/email connect`                             | Connect Gmail with read-only access.                                              |
| `/email status`                              | Inspect the Gmail connection status.                                              |
| `/email ask <request>`                       | Search or summarize email, or suggest reply text for manual sending.              |
| `/email disconnect`                          | Disconnect Gmail and Calendar and revoke their shared Google access.              |
| `/browser close`                             | Close the interactive browser and discard its tabs, cookies and page state.       |
| `/approvals`                                 | Review pending actions and their exact saved payloads.                            |
| `/approve ID` / `/reject ID`                 | Execute or decline a proposal. These commands bypass the model.                   |
| `/log`                                       | Inspect the latest 20 tool and scheduled execution outcomes.                      |
| `/goals`                                     | List goals, their status and run budgets.                                         |
| `/goal ID`                                   | Show goal progress, history and available controls.                               |
| `/goal update ID <progress>`                 | Add private progress or answer a goal question; wake it when allowed.             |
| `/goal pause/resume/cancel/complete ID`      | Manage a goal or explicitly mark it complete.                                     |
| `/goal budget ID <total>`                    | Change the total run budget without resetting runs used.                          |
| `/goal deadline ID <ISO timestamp or none>`  | Set or remove the goal deadline.                                                  |
| `/goal research ID <public request or off>`  | Set the exact public research scope or disable it.                                |
| `/tasks` / `/cancel ID`                      | Inspect or cancel scheduled work.                                                 |
| `/reset`                                     | Clear conversation history; retain journal, memory, tasks, goals and connections. |

Set a timezone before using local clock schedules. Relative delays, explicit offset timestamps and fixed intervals do not need one. Cron schedules retain their original timezone, including daylight saving behavior.

## Development

```bash
pnpm dev
pnpm test
pnpm check
pnpm exec wrangler deploy --dry-run
pnpm types
```

Run `pnpm types` whenever bindings change. Local routes are `GET /health`, optional `POST /telegram/webhook`, authenticated `POST /api/messages`, `GET /api/events`, `GET /api/files/:id`, the MCP management routes under `/api/mcp/servers`, and Google/MCP OAuth callbacks.

The implementation lives in `src/server.ts` (routing and durable orchestration), `instructions.ts` (agent policy), `execution.ts` (approvals/log), `research.ts` (public tools and Code Mode), `browser.ts` (interactive browser and frozen proposals), `structured-ai.ts` (Clairic/Clef adapters), `calendar.ts`, `memory.ts`, `journal.ts`, `journal-index.ts`, `tasks.ts`, `goals.ts`, `goal-runner.ts`, `price-research.ts`, and `prices.ts` (deterministic comparisons).
