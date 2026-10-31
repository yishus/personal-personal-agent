export type Destination = {
  channel: string;
  address: string;
  conversationId: string;
};

// Adapters authenticate the sender before constructing this envelope. Owner
// identity and destinations must never come from model output.
export type IncomingEvent = {
  ownerId: string;
  eventId: string;
  destination: Destination;
  text: string;
  providerMessageId?: string;
};

export const REACTION_EMOJIS = [
  "👀",
  "👍",
  "❤",
  "🔥",
  "🎉",
  "👏",
  "🙏",
  "👌",
  "🤝",
  "⚡"
] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export type OutboundPart =
  | { type: "text"; text: string }
  | { type: "file"; filename: string; content: string; mediaType: string };

export type DeliveryContext = {
  key: string;
  kind: "reply" | "progress" | "goal" | "task";
  sourceEventId?: string;
  expiresAt?: number;
  signal?: AbortSignal;
};

export interface ChannelAdapter {
  render(content: OutboundPart): OutboundPart[];
  send(
    destination: Destination,
    part: OutboundPart,
    context: DeliveryContext
  ): Promise<void>;
  react?(
    destination: Destination,
    messageId: string,
    emoji: ReactionEmoji,
    context: DeliveryContext
  ): Promise<void>;
  withActivity?<T>(
    destination: Destination,
    work: () => Promise<T>
  ): Promise<T>;
}

export class DeliveryError extends Error {
  readonly permanent: boolean;
  readonly retryAfter: number;
  constructor(permanent: boolean, retryAfter = 30) {
    super(
      permanent
        ? "Delivery destination unavailable."
        : "Delivery failed; retry later."
    );
    this.permanent = permanent;
    this.retryAfter = retryAfter;
  }
}
