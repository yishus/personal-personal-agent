import { telegramAdapter } from "./telegram";
import { ChannelStore } from "./channel-store";
import {
  DeliveryError,
  type ChannelAdapter,
  type DeliveryContext,
  type OutboundPart,
  type ReactionEmoji
} from "./channels";

// Register an adapter here to add a channel. The agent only handles normalized
// content and delivery failures; provider formatting and limits stay in adapters.
export class Delivery {
  private adapters: Record<string, ChannelAdapter>;
  private store: ChannelStore;
  constructor(store: ChannelStore, env: Env) {
    this.store = store;
    this.adapters = {
      telegram: telegramAdapter(env),
      api: {
        render: (content) => [content],
        send: async (destination, part, context) => {
          store.append(destination, part, context);
        }
      }
    };
  }
  private adapter(destinationId: number) {
    const destination = this.store.destination(destinationId);
    const adapter = this.adapters[destination.channel];
    if (!adapter) throw new DeliveryError(true);
    return { destination, adapter };
  }
  prepare(
    destinationId: number,
    content: OutboundPart,
    context: DeliveryContext
  ) {
    const { adapter } = this.adapter(destinationId);
    return this.store.batch(
      context.key,
      () => adapter.render(content),
      context.expiresAt
    );
  }
  async send(
    destinationId: number,
    part: OutboundPart,
    context: DeliveryContext
  ) {
    const { destination, adapter } = this.adapter(destinationId);
    await adapter.send(destination, part, context);
  }
  async withActivity<T>(destinationId: number, work: () => Promise<T>) {
    const { destination, adapter } = this.adapter(destinationId);
    return adapter.withActivity
      ? adapter.withActivity(destination, work)
      : work();
  }
  supportsReactions(destinationId: number) {
    return Boolean(this.adapter(destinationId).adapter.react);
  }
  async react(
    destinationId: number,
    messageId: string,
    emoji: ReactionEmoji,
    context: DeliveryContext
  ) {
    const { destination, adapter } = this.adapter(destinationId);
    if (!adapter.react) throw new DeliveryError(true);
    await adapter.react(destination, messageId, emoji, context);
  }
}
