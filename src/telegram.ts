import { z } from "zod";
import {
  DeliveryError,
  type ChannelAdapter,
  type ReactionEmoji
} from "./channels.ts";

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z
    .object({
      message_id: z.number().int(),
      from: z.object({ id: z.number().int(), is_bot: z.boolean() }).optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      text: z.string().optional()
    })
    .optional()
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type IncomingMessage = {
  updateId: number;
  messageId: number;
  chatId: number;
  text: string;
};

export function parseAllowedUserIds(
  value: string | undefined
): Set<string> | null {
  const ids = value?.split(",").map((id) => id.trim());
  if (!ids?.length || ids.some((id) => !/^[1-9]\d*$/.test(id))) return null;
  return new Set(ids);
}

export function authorizedMessage(
  update: TelegramUpdate,
  allowedUserIds: ReadonlySet<string>
): IncomingMessage | null {
  const message = update.message;
  if (
    !message ||
    message.chat.type !== "private" ||
    message.from?.is_bot ||
    !allowedUserIds.has(String(message.from?.id))
  )
    return null;
  return {
    updateId: update.update_id,
    messageId: message.message_id,
    chatId: message.chat.id,
    text: message.text ?? "/unsupported"
  };
}

export function splitMessage(text: string): string[] {
  // Bound UTF-16 length conservatively and preserve complete surrogate pairs.
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > 4000) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class TelegramError extends DeliveryError {
  code: number;
  retryAfter: number;
  constructor(code: number, retryAfter = 30) {
    super([400, 403].includes(code), retryAfter);
    this.message = `Telegram API failed (${code})`;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function telegramAdapter(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">
): ChannelAdapter {
  return {
    react: async (destination, messageId, emoji, context) => {
      if (!env.TELEGRAM_BOT_TOKEN) throw new DeliveryError(true);
      await setTelegramReaction(
        env.TELEGRAM_BOT_TOKEN,
        Number(destination.address),
        Number(messageId),
        emoji,
        context.signal
      );
    },
    render: (content) =>
      content.type === "file"
        ? [content]
        : splitMessage(content.text).map((text) => ({
            type: "text" as const,
            text
          })),
    send: async (destination, part, context) => {
      if (!env.TELEGRAM_BOT_TOKEN) throw new DeliveryError(true);
      if (part.type === "file")
        await sendTelegramDocument(
          env.TELEGRAM_BOT_TOKEN,
          Number(destination.address),
          part.filename,
          part.content
        );
      else
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          Number(destination.address),
          part.text,
          context.signal
        );
    },
    withActivity: (destination, work) =>
      env.TELEGRAM_BOT_TOKEN
        ? withTypingIndicator(
            env.TELEGRAM_BOT_TOKEN,
            Number(destination.address),
            work
          )
        : work()
  };
}

export async function withTypingIndicator<T>(
  token: string,
  chatId: number,
  generate: () => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let stopped = false;
  let sending = false;
  const refresh = async () => {
    if (stopped || sending) return;
    sending = true;
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendChatAction`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, action: "typing" }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(3000)
          ])
        }
      );
      // Stop on API rejection, including rate limits. Typing is best effort.
      if (!response.ok) stopped = true;
      await response.body?.cancel();
    } catch {
      // Never let a typing failure interrupt generation or log token-bearing URLs.
    } finally {
      sending = false;
    }
  };

  // Telegram expires the status after five seconds, so refresh every four.
  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, 4000);
  try {
    return await generate();
  } finally {
    stopped = true;
    clearInterval(timer);
    controller.abort();
  }
}

export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  signal?: AbortSignal
) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Untrusted page text can contain tracking/exfiltration links. Telegram
      // must not fetch those URLs automatically while rendering a reply.
      body: JSON.stringify({
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true }
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000)
    }
  );
  await checkTelegramResponse(response);
}

export async function setTelegramReaction(
  token: string,
  chatId: number,
  messageId: number,
  emoji: ReactionEmoji,
  signal?: AbortSignal
) {
  if (!Number.isSafeInteger(messageId) || messageId <= 0)
    throw new DeliveryError(true);
  const response = await fetch(
    `https://api.telegram.org/bot${token}/setMessageReaction`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }]
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000)
    }
  );
  await checkTelegramResponse(response);
}

export async function sendTelegramDocument(
  token: string,
  chatId: number,
  filename: string,
  content: string
) {
  const body = new FormData();
  body.set("chat_id", String(chatId));
  const calendar = filename.endsWith(".ics");
  if (calendar) {
    body.set(
      "caption",
      "Calendar draft — review the dates and times, then import this .ics file in your calendar app. Nothing has been added automatically; no invitations have been sent."
    );
    body.set("disable_content_type_detection", "true");
  }
  body.set(
    "document",
    new Blob([content], {
      type: calendar
        ? "text/calendar; charset=utf-8"
        : "text/markdown; charset=utf-8"
    }),
    filename
  );
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendDocument`,
    { method: "POST", body, signal: AbortSignal.timeout(20_000) }
  );
  await checkTelegramResponse(response);
}

async function checkTelegramResponse(response: Response) {
  const result = (await response.json()) as {
    ok: boolean;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  if (!response.ok || !result.ok) {
    // Never include the request URL (which contains the token) in errors.
    throw new TelegramError(
      result.error_code ?? response.status,
      result.parameters?.retry_after
    );
  }
}
