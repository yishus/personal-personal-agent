import { z } from "zod";
import { REACTION_EMOJIS, type ReactionEmoji } from "./channels.ts";

export const reactionInput = z
  .object({
    emoji: z.enum(REACTION_EMOJIS),
    finishTurn: z
      .boolean()
      .default(false)
      .describe(
        "False acknowledges the request and continues work. True finishes without text; call alone, in a later step after all requested actions succeed. Never finish with 👀 or omit results, errors, questions or required details."
      )
  })
  .strict();

export type ReactionOnlyReply = { type: "reaction"; emoji: ReactionEmoji };

/** A successful acknowledgement alone never authorizes a silent finish. */
export class ReactionSession {
  finished: ReactionOnlyReply | null = null;
  private canFinish = false;
  private failed = false;
  private send: (emoji: ReactionEmoji) => Promise<void>;
  private commit: (reply: ReactionOnlyReply) => void;

  constructor(
    send: (emoji: ReactionEmoji) => Promise<void>,
    commit: (reply: ReactionOnlyReply) => void
  ) {
    this.send = send;
    this.commit = commit;
  }

  prepareStep(toolNames: string[]) {
    this.canFinish =
      toolNames.length === 1 && toolNames[0] === "reactToMessage";
  }

  noteFailure() {
    this.failed = true;
  }

  async react({ emoji, finishTurn }: z.infer<typeof reactionInput>) {
    if (finishTurn && (!this.canFinish || this.failed || emoji === "👀"))
      return {
        error:
          "Use a separate reaction call only after successful work. Send text for failures or anything that still needs attention. 👀 acknowledges work but cannot finish it."
      };
    try {
      await this.send(emoji);
    } catch {
      this.failed = true;
      return {
        error:
          "The reaction could not be delivered. Continue the requested work and send a short text reply instead."
      };
    }
    if (finishTurn) {
      const reply: ReactionOnlyReply = { type: "reaction", emoji };
      // Checkpoint only after confirmed delivery; inbox recovery must not
      // rerun completed actions or turn a silent success into an error reply.
      this.commit(reply);
      this.finished = reply;
    }
    return { status: "reacted", emoji, finished: finishTurn };
  }
}
