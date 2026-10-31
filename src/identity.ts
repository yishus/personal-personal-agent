import { z } from "zod";

// Telegram identities can also be assigned API credentials to link channels
// to the same owner's data while keeping conversation context separate.
export const ownerIdSchema = z
  .string()
  .regex(/^(?:owner:[A-Za-z0-9_-]{1,64}|telegram:[1-9]\d*)$/);
const accountsSchema = z
  .array(
    z.object({
      ownerId: ownerIdSchema,
      token: z.string().min(32).max(512),
      permissions: z
        .array(z.enum(["mcp:manage"]))
        .max(1)
        .default([])
    })
  )
  .min(1)
  .max(100);

export function apiAccounts(env: Pick<Env, "API_ACCOUNTS">) {
  try {
    const accounts = accountsSchema.parse(JSON.parse(env.API_ACCOUNTS ?? ""));
    if (
      new Set(accounts.map((account) => account.token)).size !== accounts.length
    )
      return null;
    return accounts;
  } catch {
    return null;
  }
}

export async function authenticateApi(
  request: Request,
  env: Pick<Env, "API_ACCOUNTS">
) {
  const accounts = apiAccounts(env);
  if (!accounts) return { status: 503 as const };
  const token = /^Bearer ([^\s]+)$/.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  if (!token || token.length > 512) return { status: 401 as const };
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    );
  const [provided, ...expected] = await Promise.all([
    digest(token),
    ...accounts.map((account) => digest(account.token))
  ]);
  const index = expected.findIndex((hash) => {
    let different = 0;
    for (let i = 0; i < hash.length; i++) different |= hash[i] ^ provided[i];
    return different === 0;
  });
  return index < 0
    ? { status: 401 as const }
    : {
        status: 200 as const,
        ownerId: accounts[index].ownerId,
        permissions: accounts[index].permissions
      };
}
