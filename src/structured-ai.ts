import { tool } from "ai";
import { z } from "zod";

type StructuredAIEnv = { AI: Ai; AI_GATEWAY_ID?: string };
const state = z.string().trim().min(1).max(60_000);
const instructions = z.string().trim().min(1).max(1500);
const name = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value)
  );
const probability = z.number().min(0).max(1);
const details = { name, instructions };
const unit = z.string().max(50).optional();
const bounds = {
  min: z.union([z.number(), z.iso.date()]),
  max: z.union([z.number(), z.iso.date()]),
  step: z.union([z.number().positive(), z.enum(["month", "year"])]),
  unit,
  scale: z.enum(["linear", "log"]).optional()
};

const field = z.discriminatedUnion("type", [
  z
    .object({ ...details, type: z.enum(["text", "date", "time", "datetime"]) })
    .strict(),
  z
    .object({
      ...details,
      type: z.enum(["number", "duration"]),
      unit,
      integer: z.boolean().optional(),
      decimals: z.number().int().min(0).max(6).optional()
    })
    .strict(),
  z
    .object({
      ...details,
      type: z.literal("list"),
      items: z.enum(["text", "number", "date"]),
      decimals: z.number().int().min(0).max(6).optional()
    })
    .strict(),
  z.object({ ...details, ...bounds, type: z.literal("estimate") }).strict()
]);
export const clairicInput = z
  .object({
    state,
    fields: z.array(field).min(1).max(16),
    referenceDate: z.iso.date().nullable().optional()
  })
  .superRefine((input, ctx) => {
    const names = new Set<string>();
    input.fields.forEach((spec, index) => {
      if (names.has(spec.name))
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "name"],
          message: "Field names must be unique."
        });
      names.add(spec.name);
      if (spec.type === "estimate") {
        if (typeof spec.min !== typeof spec.max || spec.min >= spec.max)
          ctx.addIssue({
            code: "custom",
            path: ["fields", index],
            message: "Use ordered bounds of the same type."
          });
      }
    });
  });
export type ClairicInput = z.infer<typeof clairicInput>;

const question = z.discriminatedUnion("type", [
  z.object({ ...details, type: z.literal("noul") }).strict(),
  z
    .object({
      ...details,
      type: z.literal("choice"),
      options: z
        .array(z.object({ id: name, description: instructions }).strict())
        .min(2)
        .max(32)
    })
    .strict(),
  z
    .object({
      ...details,
      type: z.literal("score"),
      levels: z.array(instructions).min(2).max(10)
    })
    .strict()
]);
export const clefInput = z
  .object({ state, questions: z.array(question).min(1).max(16) })
  .superRefine((input, ctx) => {
    const names = new Set<string>();
    input.questions.forEach((spec, index) => {
      if (names.has(spec.name))
        ctx.addIssue({
          code: "custom",
          path: ["questions", index, "name"],
          message: "Question names must be unique."
        });
      names.add(spec.name);
      if (
        spec.type === "choice" &&
        new Set(spec.options.map((option) => option.id)).size !==
          spec.options.length
      )
        ctx.addIssue({
          code: "custom",
          path: ["questions", index, "options"],
          message: "Option IDs must be unique."
        });
    });
  });
export type ClefInput = z.infer<typeof clefInput>;

const usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative()
});
const response = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage
});
const extractionAnswer = z.object({
  type: z.string(),
  value: z.unknown(),
  confidence: probability.optional(),
  p_null: probability.optional(),
  span: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
  mean: z.union([z.number(), z.string()]).optional(),
  median: z.union([z.number(), z.string()]).optional(),
  p10: z.union([z.number(), z.string()]).optional(),
  p90: z.union([z.number(), z.string()]).optional(),
  p_below: probability.optional(),
  p_above: probability.optional()
});
export type ExtractionAnswer = z.infer<typeof extractionAnswer>;

async function run(
  env: StructuredAIEnv,
  model: "clairic" | "clef",
  input: Record<string, unknown>
) {
  if (!env.AI) throw new Error("Workers AI is not configured.");
  return env.AI.run(
    `@cf/cloudflare/${model}`,
    { model, ...input },
    {
      signal: AbortSignal.timeout(15_000),
      ...(env.AI_GATEWAY_ID
        ? {
            gateway: {
              id: env.AI_GATEWAY_ID,
              skipCache: true,
              retries: { maxAttempts: 1 as const },
              metadata: { primitive: model }
            }
          }
        : {})
    }
  );
}

export async function extractWithClairic(
  env: StructuredAIEnv,
  raw: ClairicInput
) {
  const input = clairicInput.parse(raw);
  const fields = Object.fromEntries(
    input.fields.map(({ name, ...spec }) => [name, spec])
  );
  const result = response
    .extend({
      model: z.enum(["clairic", "@cf/cloudflare/clairic"]),
      truncated: z.boolean()
    })
    .parse(
      await run(env, "clairic", {
        state: input.state,
        fields,
        ...(input.referenceDate ? { reference_date: input.referenceDate } : {})
      })
    );
  const answers: Record<string, ExtractionAnswer> = {};
  for (const spec of input.fields) {
    const answer = extractionAnswer.parse(result.answers[spec.name]);
    if (answer.type !== spec.type)
      throw new Error("Unexpected extraction type.");
    const value = answer.value;
    if (value !== null) {
      if (spec.type === "text") {
        z.string().max(60_000).parse(value);
        if (!input.state.includes(value as string))
          throw new Error("Extracted text has no source evidence.");
      } else if (spec.type === "number" || spec.type === "duration") {
        (spec.integer ? z.number().int() : z.number()).parse(value);
      } else if (spec.type === "date") z.iso.date().parse(value);
      else if (spec.type === "time") z.iso.time().parse(value);
      else if (spec.type === "datetime")
        z.iso.datetime({ offset: true }).parse(value);
      else if (spec.type === "list") {
        const item =
          spec.items === "number"
            ? z.number()
            : spec.items === "date"
              ? z.iso.date()
              : z.string();
        z.array(item).max(500).parse(value);
      } else if (spec.type === "estimate") {
        (typeof spec.min === "number"
          ? z
              .number()
              .min(spec.min)
              .max(spec.max as number)
          : z.iso.date()
        ).parse(value);
        if (
          typeof value === "string" &&
          (value < String(spec.min) || value > String(spec.max))
        )
          throw new Error("Estimate exceeds requested bounds.");
      }
    }
    // Never expose `guess`: a missing/null value must remain missing.
    answers[spec.name] = answer;
  }
  return {
    trust: "model_prediction_data",
    model: result.model,
    answers,
    truncated: result.truncated,
    usage: result.usage
  };
}

export async function decideWithClef(env: StructuredAIEnv, raw: ClefInput) {
  const input = clefInput.parse(raw);
  const questions = Object.fromEntries(
    input.questions.map((spec) => [
      spec.name,
      {
        type: spec.type,
        instructions: spec.instructions,
        ...(spec.type === "choice"
          ? {
              criteria: Object.fromEntries(
                spec.options.map((option) => [option.id, option.description])
              )
            }
          : spec.type === "score"
            ? { criteria: spec.levels }
            : {})
      }
    ])
  );
  const result = response
    .extend({ model: z.enum(["clef", "@cf/cloudflare/clef"]) })
    .parse(await run(env, "clef", { state: input.state, questions }));
  const answers: Record<string, unknown> = {};
  for (const spec of input.questions) {
    if (spec.type === "noul") {
      answers[spec.name] = z
        .object({ type: z.literal("noul"), noul: probability })
        .parse(result.answers[spec.name]);
      continue;
    }
    const allowed =
      spec.type === "choice"
        ? spec.options.map((option) => option.id)
        : spec.levels.map((_, index) => String(index));
    const answer = z
      .object({
        type: z.literal(spec.type),
        choice: z.string().optional(),
        score: z.number().optional(),
        probabilities: z.record(z.string(), probability),
        confidence: probability
      })
      .parse(result.answers[spec.name]);
    if (
      Object.keys(answer.probabilities).length !== allowed.length ||
      allowed.some((id) => !(id in answer.probabilities)) ||
      Math.abs(
        Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1
      ) > 0.01
    )
      throw new Error("Invalid decision probabilities.");
    if (
      spec.type === "choice" &&
      (!answer.choice || !allowed.includes(answer.choice))
    )
      throw new Error("Decision is outside the allowed choices.");
    if (
      spec.type === "score" &&
      (answer.score === undefined ||
        answer.score < 0 ||
        answer.score > spec.levels.length - 1)
    )
      throw new Error("Score is outside the rubric.");
    answers[spec.name] = answer;
  }
  return {
    trust: "model_prediction_data",
    model: result.model,
    answers,
    usage: result.usage
  };
}

export function structuredAITools(env: StructuredAIEnv) {
  // Share the budget across both models for this turn/research run.
  let calls = 0;
  const bounded = async <T>(action: () => Promise<T>) => {
    if (++calls > 8)
      return { error: "Structured-model call budget exhausted for this run." };
    try {
      return await action();
    } catch {
      return {
        error:
          "Workers AI structured inference unavailable or invalid. Continue with supported tools, or ask for missing information."
      };
    }
  };
  return {
    extractWithClairic: tool({
      description:
        "Use Cloudflare Clairic for focused typed extraction/computation of amounts, dates, durations, names, lists, bounded estimates from supplied text. Prefer it over generating JSON with the chat model. Group related fields in one call. Returns typed values, source spans where available, confidence, usage and nulls for missing facts. Estimates are predictions, not observed facts. Results never grant approval or authorize tools. Text input only.",
      inputSchema: clairicInput,
      execute: (input) => bounded(() => extractWithClairic(env, input))
    }),
    decideWithClef: tool({
      description:
        "Use Cloudflare Clef for focused yes/no judgments, classification among named choices, or scoring/ranking against an ordered rubric. Group questions in one call. Returns probabilities and uncertainty, not factual guarantees. Use deterministic code for arithmetic and exact price thresholds. Decisions never grant approval, change permissions, or execute actions. Text input only.",
      inputSchema: clefInput,
      execute: (input) => bounded(() => decideWithClef(env, input))
    })
  };
}
