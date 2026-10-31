# Channels and the HTTP API

The personal agent runs on Cloudflare Workers. Telegram and the authenticated HTTP API are communication adapters. Journal, memory, goals, tasks, connectors, approvals, and execution logs belong to an owner. Each conversation has separate chat history and public research context. The owner's timezone, saved facts, journal, goals, approvals, and Google credentials are shared across that owner's conversations.

## HTTP-only setup

Complete the shared [Cloudflare setup](../README.md#deploy-to-cloudflare) through step 5 to create the Worker and configure AI Gateway before uploading interface secrets. For HTTP-only use, configure `API_ACCOUNTS` and skip the optional Telegram setup. This is a JSON array stored as a Worker secret:

```json
[
  {
    "ownerId": "owner:alice",
    "token": "REPLACE_WITH_A_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS"
  }
]
```

Generate a token with `openssl rand -hex 32`, then upload the JSON with `pnpm exec wrangler secret put API_ACCOUNTS`; the secret change is deployed immediately. For local development, put the JSON on one line in `.dev.vars`, enclosed in single quotes. Owner names have the form `owner:NAME`, where NAME contains 1–64 letters, digits, underscores, or hyphens. Multiple tokens can map to one owner, and multiple owners can share a deployment. Duplicate tokens, short tokens, and malformed configuration disable the API. Telegram requires no configuration when using only HTTP.

Every API endpoint requires `Authorization: Bearer TOKEN`. The server derives the owner from this credential. Requests cannot choose an owner or notification destination. A token grants access to that owner's personal agent and data; use it in a trusted client. Browser clients hosted on another origin should use an authenticated server proxy; cross-origin access is not enabled by default.

MCP administration additionally requires `permissions: ["mcp:manage"]` on the matching token. Omitting `permissions` grants no MCP management access. Missing/invalid credentials return HTTP 401; a valid token without that permission returns HTTP 403 for every `/api/mcp/` route. Both checks run before an agent is resolved or a connection is attempted. You can give the same owner separate normal and administration tokens. These permissions control MCP management; both tokens still have that owner's ordinary messaging/API access. A Telegram allowlist entry alone does not grant REST access.

## Manage MCP connections

Add the permission only to users/tokens allowed to manage connections, for example:

```json
[
  {
    "ownerId": "owner:alice",
    "token": "ALICE_NORMAL_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS"
  },
  {
    "ownerId": "owner:alice",
    "token": "ALICE_ADMIN_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS",
    "permissions": ["mcp:manage"]
  }
]
```

Save the complete account array with `pnpm exec wrangler secret put API_ACCOUNTS`, preserving the existing accounts you want to retain. For a Telegram user's bot to use these connections, assign the token to `ownerId: "telegram:THEIR_PRIVATE_CHAT_ID"`. Connections are scoped to that owner and are available across their conversations. An administrator cannot supply another owner's ID in a request or manage another owner's connections.

Create a remote connection using an administration token:

```sh
curl https://YOUR-WORKER/api/mcp/servers \
  -H "Authorization: Bearer $MCP_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Cloudflare Docs","url":"https://docs.mcp.cloudflare.com/mcp"}'
```

HTTP 201 means the server connected and its tools were discovered:

```json
{
  "connection": {
    "id": "mcp-SERVER_ID",
    "name": "Cloudflare Docs",
    "url": "https://docs.mcp.cloudflare.com/mcp",
    "state": "ready",
    "authUrl": null,
    "tools": ["search_cloudflare_documentation"]
  }
}
```

`transport` optionally selects `auto` (default), `streamable-http`, or legacy `sse`. For token-authenticated servers, include `headers`, such as `{"Authorization":"Bearer SERVICE_TOKEN"}` or a service's API key/Cloudflare Access headers. This is separate from the administration bearer token in the request header. Credentials are stored by the MCP client and are never returned by management endpoints. Returned server URLs omit query parameters, and upstream diagnostic messages are replaced with safe errors. Request bodies are limited to 16 KiB. Only public HTTPS server hostnames on the standard port are accepted; local commands, IP addresses, embedded URL credentials, private hostnames and fragments are rejected. There are at most 20 connections per owner.

If the server requires OAuth, creation returns HTTP 202 with `state: "authenticating"` and `authUrl`. Open that URL in a browser to authorize the server. The SDK validates the callback's stored URL, one-time state and PKCE at `/connectors/mcp/:owner/callback`; no chat command or bearer token in the callback URL is needed. The owner must still have an administration account when completing authorization. The callback origin comes from `PUBLIC_BASE_URL` when set, otherwise the REST request origin. HTTP localhost is accepted for local callback development. Poll the connection endpoint for its status after authorizing.

All management endpoints require `mcp:manage`:

| Method   | Endpoint               | Result                                                         |
| -------- | ---------------------- | -------------------------------------------------------------- |
| `POST`   | `/api/mcp/servers`     | Add a connection; 201 ready or 202 awaiting OAuth.             |
| `GET`    | `/api/mcp/servers`     | List this owner's connections, status and tool names.          |
| `GET`    | `/api/mcp/servers/:id` | Inspect one connection; 404 for unknown or another owner's ID. |
| `DELETE` | `/api/mcp/servers/:id` | Disconnect and remove credentials; 204 on success.             |

Names must be unique within an owner (case-insensitive); a duplicate returns HTTP 409 with the existing connection ID. To replace a URL or rotate credentials, delete the old connection and add it again. A connection/discovery failure returns HTTP 502 and its registration ID; list connections to find any saved failed registration and delete it before retrying. Connections and credentials survive agent restarts through the [Agents SDK MCP client](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/).

After setup, users can ask the bot to use the configured service. The bot delegates the exact current message to an isolated MCP session, scoped to one connection, without private chat history, journal, memory, calendar data or other tool results. Remote descriptions/results are untrusted evidence. Installing a connection does not itself authorize unrelated external changes; each task still requires a current user request. A run exposes up to 100 discovered tools, makes at most eight calls and bounds textual results; binary results are omitted. MCP results are delivered directly and omitted from private conversation history, so follow-ups must include the necessary subject/details again. Connections are managed exclusively through REST. Scheduled tasks and goal runners currently do not use MCP tools.

## Submit a message

```sh
curl https://YOUR-WORKER/api/messages \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"request-001","conversationId":"main","text":"Remind me to stretch in 20 minutes"}'
```

The response is HTTP 202 after the input and its wake-up are durable:

```json
{ "id": "request-001", "conversationId": "main", "status": "queued" }
```

`conversationId` defaults to `main` and accepts 1–100 letters, digits, underscores, or hyphens. `text` accepts up to 16,000 characters. The complete request body is bounded at 128 KiB. The client supplies an `id` containing 1–200 letters, digits, underscores, periods, colons, or hyphens. IDs are unique per owner and channel, across conversations. Repeating an identical request returns its existing status without generating another reply. Reusing an ID for different content returns HTTP 409. Deduplication metadata is kept for seven days; use a new ID for a genuinely new request.

## Read replies and notifications

```sh
curl 'https://YOUR-WORKER/api/events?after=0' \
  -H "Authorization: Bearer $AGENT_API_TOKEN"
```

```json
{
  "events": [
    {
      "id": 1,
      "conversationId": "main",
      "kind": "reply",
      "sourceEventId": "request-001",
      "createdAt": 1793000000000,
      "type": "text",
      "text": "Reminder saved."
    }
  ],
  "nextCursor": 1
}
```

Persist `nextCursor` and pass it as `after` on the next poll. Each page contains up to 100 events. An optional `conversationId` query parameter filters the feed; maintain a separate cursor for each filtered feed. `kind` is `reply`, `progress`, `goal`, or `task`. `sourceEventId` correlates an immediate reply or progress notice with its input; scheduled notifications can have a null source. This is a durable polling feed, not a token stream. Poll every few seconds while awaiting work and less frequently otherwise.

API events are accepted idempotently using durable delivery keys. Replaying a delivery after a restart does not append a second copy. Telegram delivery remains at least once because acceptance and the local checkpoint cannot be committed together.

Goals and tasks retain the destination where they were created. An HTTP-created goal continues notifying its original API conversation even after messages arrive through Telegram or another conversation. Notifications are never broadcast to other destinations.

Ordinary events and files remain available for seven days. Email answers expire after one hour and are removed from the API feed on Google disconnect. Expired records are removed when the feed is accessed, when new output is stored, and by existing email-expiry alarms. Clients may retain their own copies. Every API response uses `Cache-Control: no-store`.

## Download files

Journal exports and calendar drafts appear as file events:

```json
{
  "id": 2,
  "conversationId": "main",
  "kind": "reply",
  "sourceEventId": "export-001",
  "createdAt": 1793000000000,
  "type": "file",
  "filename": "journal-2026-10-27.md",
  "mediaType": "text/markdown; charset=utf-8",
  "downloadUrl": "/api/files/2"
}
```

Fetch `downloadUrl` on the same Worker with the same bearer token. File contents are omitted from event listings. Downloads are scoped to the authenticated owner, expire with the event, and use attachment disposition. Calendar files still require review and import by the user.

## Structured actions

Submit `action` in place of `text` to call the same application handlers used by slash commands. Actions execute through the durable inbox and produce ordinary reply events:

```json
{
  "id": "progress-001",
  "action": {
    "type": "goals.update",
    "goalId": "GOAL_ID",
    "progress": "I finished chapter one."
  }
}
```

```json
{
  "id": "pause-001",
  "action": {
    "type": "goals.control",
    "goalId": "GOAL_ID",
    "operation": "pause"
  }
}
```

```json
{
  "id": "approval-001",
  "action": {
    "type": "approvals.decide",
    "id": "APPROVAL_ID",
    "decision": "approve"
  }
}
```

Supported actions are defined by `actionSchema` in [`src/actions.ts`](../src/actions.ts):

| Action                                                                                                      | Additional fields                                                          |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `help`, `goals.list`, `tasks.list`, `approvals.list`, `timezone.get`, `conversation.reset`, `journal.index` | None                                                                       |
| `goals.get`                                                                                                 | `goalId`                                                                   |
| `goals.update`                                                                                              | `goalId`, `progress`                                                       |
| `goals.control`                                                                                             | `goalId`, `operation`: `pause`, `resume`, `cancel`, or `complete`          |
| `goals.budget`                                                                                              | `goalId`, `maxRuns`                                                        |
| `goals.deadline`                                                                                            | `goalId`, `deadline`: ISO timestamp or null                                |
| `goals.research`                                                                                            | `goalId`, `publicBrief`: public request or null to disable                 |
| `tasks.cancel`                                                                                              | `id`                                                                       |
| `approvals.decide`                                                                                          | `id`, `decision`: `approve` or `reject`                                    |
| `timezone.set`                                                                                              | `timezone`: IANA timezone                                                  |
| `journal.read`, `journal.export`                                                                            | Optional `date`: YYYY-MM-DD                                                |
| `connector.control`                                                                                         | `connector`: `calendar` or `email`; `operation`: `connect` or `disconnect` |

Goal creation and other natural-language requests use `text`. Slash commands are also accepted over HTTP. `conversation.reset` clears only the current conversation and its research thread. It retains the owner's journal, memory, tasks, goals, and other conversations. Google connection actions return a consent link in the reply; open that link to complete OAuth.

## Storage

`inbox_jobs` stores incoming work for every channel; `scheduled_tasks` stores reminders and recurring work. Jobs use internal `message_id` values, and jobs, tasks, and goals use `destination_id` to reference `channel_destinations`. A persistent sequence assigns positive internal IDs for all channels without reusing them after inbox cleanup. Provider event IDs are stored separately and namespaced by channel. Conversation history and public research context live in `channel_conversations`; journal and memory records refer to `source_message_id`.

The schema is created directly on first deployment. Inbox initialization adds `provider_message_id` and `reply_kind` to existing inbox tables for reaction support; other earlier development schemas have no upgrade path. The provider message ID is distinct from the update/event ID and is supplied by the authenticated adapter. A completed reaction-only reply is checkpointed before the turn finishes, so recovery does not generate a fallback text message or rerun its actions.

## Adding an adapter

1. Authenticate the provider request, resolve its owner using trusted configuration or verified account linking, and construct an `IncomingEvent` from [`src/channels.ts`](../src/channels.ts). A destination includes a channel name, an opaque address, and a namespaced conversation ID. Forward the event to the owner's `receiveEvent` method.
2. Implement `ChannelAdapter`: `render` converts neutral text/files into provider-compatible parts; `send` delivers one part; optional `withActivity` displays a best-effort activity indicator. Optional `react` sets an emoji on the provider message supplied in `IncomingEvent.providerMessageId`. Only adapters with this capability and a message target expose the reaction tool; the HTTP API continues producing text/file events. See `telegramAdapter` in [`src/telegram.ts`](../src/telegram.ts).
3. Register the adapter in [`src/delivery.ts`](../src/delivery.ts). Translate delivery rejection and rate limits into `DeliveryError`, preserving whether failure is permanent and its retry delay. Keep secrets and credential-bearing URLs out of errors.
4. Test authenticated input, duplicate events, files, restart recovery, and scheduled delivery. Preserve private destinations and disable automatic URL previews where supported.

The core freezes rendered parts before sending and owns retries and checkpoints. Adapters must not silently change recipients, execute model-generated actions, or claim delivery before the provider or durable event store has accepted it. New channel configuration should be optional; an unconfigured adapter must not prevent other channels from starting.
