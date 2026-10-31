import { z } from "zod";

export const priceCondition = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("price_drop"),
    percent: z.number().positive().max(100),
    baseline: z.enum(["initial", "previous"])
  }),
  z.object({
    type: z.literal("lowest_price"),
    targetUrl: z.string().url().nullable()
  })
]);
export type PriceCondition = z.infer<typeof priceCondition>;
export type Price = {
  url: string;
  amount: string;
  currency: string;
  identity: string;
};
export type PriceState = {
  initial: Price[];
  previous: Price[];
  signal: string | null;
};

// Six fixed decimal places avoid floating-point errors at the exact threshold.
export function priceUnits(amount: string): bigint {
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(amount))
    throw new Error("Invalid decimal price.");
  const [whole, fractional = ""] = amount.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0"));
  if (units <= 0n) throw new Error("Price must be positive.");
  return units;
}

export function comparePrices(
  condition: PriceCondition,
  current: Price[],
  saved: PriceState | null
): { reply: string | null; state: PriceState } {
  condition = priceCondition.parse(condition);
  if (
    !current.length ||
    new Set(current.map((p) => p.url)).size !== current.length
  )
    throw new Error("Missing or duplicate price sources.");
  for (const price of current) {
    priceUnits(price.amount);
    if (!/^[A-Z]{3}$/.test(price.currency) || !price.identity.trim())
      throw new Error("Missing currency or product identity.");
  }
  const initial = saved?.initial ?? current;
  if (saved) {
    if (initial.length !== current.length)
      throw new Error("The set of tracked sources changed.");
    for (const price of current) {
      const original = initial.find((p) => p.url === price.url);
      if (
        !original ||
        original.currency !== price.currency ||
        original.identity.trim().toLowerCase() !==
          price.identity.trim().toLowerCase()
      )
        throw new Error(
          "Currency or product variant changed; comparison unavailable."
        );
    }
  }
  let signal: string | null = null;
  const lines: string[] = [];
  if (condition.type === "price_drop") {
    // Preserve the requested decimal percentage, including small values in
    // exponent notation, rather than rounding it to whole basis points.
    const [coefficient, exponent = "0"] = condition.percent
      .toString()
      .split("e");
    const [whole, fraction = ""] = coefficient.split(".");
    const scale = fraction.length - Number(exponent);
    const numerator =
      BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale));
    const denominator = 100n * 10n ** BigInt(Math.max(0, scale));
    const reference =
      condition.baseline === "initial" ? initial : saved?.previous;
    if (saved && reference)
      for (const price of current) {
        const old = reference.find((p) => p.url === price.url);
        if (!old || old.currency !== price.currency)
          throw new Error("Missing comparable baseline.");
        if (
          priceUnits(price.amount) * denominator <=
          priceUnits(old.amount) * (denominator - numerator)
        )
          lines.push(
            `${price.identity}: ${price.currency} ${old.amount} → ${price.amount}\n${price.url}`
          );
      }
    signal = lines.length
      ? lines
          .map((line) => line.split("\n")[1])
          .sort()
          .join("|")
      : null;
  } else {
    if (
      current.length < 2 ||
      new Set(current.map((p) => p.currency)).size !== 1
    )
      throw new Error(
        "Comparison needs two or more prices in the same currency."
      );
    if (
      condition.targetUrl &&
      !current.some((p) => p.url === condition.targetUrl)
    )
      throw new Error("Target must be one of the tracked URLs.");
    const ordered = [...current].sort((a, b) =>
      priceUnits(a.amount) < priceUnits(b.amount)
        ? -1
        : priceUnits(a.amount) > priceUnits(b.amount)
          ? 1
          : 0
    );
    if (
      priceUnits(ordered[0].amount) < priceUnits(ordered[1].amount) &&
      (!condition.targetUrl || condition.targetUrl === ordered[0].url)
    ) {
      signal = ordered[0].url;
      lines.push(
        `Lowest price: ${ordered[0].identity}, ${ordered[0].currency} ${ordered[0].amount}\n${ordered[0].url}`
      );
    }
  }
  // Notify on entering the condition or changing the winning product. A
  // continuing match stays silent; recovery above the threshold rearms it.
  const notify = signal !== null && signal !== saved?.signal;
  return {
    reply: notify ? lines.join("\n\n") : null,
    state: { initial, previous: current, signal } satisfies PriceState
  };
}
