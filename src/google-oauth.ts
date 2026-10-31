// Google revocation is per user/project, across clients and scopes. Keep local
// Calendar and Gmail state consistent whenever a grant is revoked.
type StoredToken = { refresh_token?: string; access_token?: string };

export async function clearGoogleAccess(
  storage: DurableObjectStorage,
  credentials: string[] = []
) {
  await storage.transaction(async (tx) => {
    const queue = new Set([
      ...((await tx.get<string[]>("google.revocation_pending")) ?? []),
      ...credentials
    ]);
    for (const service of ["calendar", "email"]) {
      const token = await tx.get<StoredToken>(`${service}.token`);
      const credential = token?.refresh_token ?? token?.access_token;
      if (credential) queue.add(credential);
      await tx.put(`${service}.generation`, crypto.randomUUID());
      await tx.delete([`${service}.token`, `${service}.oauth`]);
    }
    if (queue.size) await tx.put("google.revocation_pending", [...queue]);
  });
}

export async function googleRevocationPending(storage: DurableObjectStorage) {
  return Boolean(
    (await storage.get<string[]>("google.revocation_pending"))?.length
  );
}

export async function revokeGoogleCredentials(
  storage: DurableObjectStorage,
  credentials: string[] = []
) {
  // Rejecting a new token can revoke existing tokens for the same app too.
  if (credentials.length || (await googleRevocationPending(storage)))
    await clearGoogleAccess(storage, credentials);
  const queue =
    (await storage.get<string[]>("google.revocation_pending")) ?? [];
  for (const credential of queue) {
    try {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: credential }),
        signal: AbortSignal.timeout(10_000)
      });
      const invalid =
        response.status === 400 &&
        (await response.json<{ error?: string }>()).error === "invalid_token";
      if (!response.ok && !invalid) {
        await response.body?.cancel();
        continue;
      }
      if (!response.bodyUsed) await response.body?.cancel();
      await storage.transaction(async (tx) => {
        const remaining = (
          (await tx.get<string[]>("google.revocation_pending")) ?? []
        ).filter((token) => token !== credential);
        if (remaining.length)
          await tx.put("google.revocation_pending", remaining);
        else await tx.delete("google.revocation_pending");
      });
    } catch {
      /* The credential remains solely for a later revocation attempt. */
    }
  }
  return !(await googleRevocationPending(storage));
}

export async function disconnectGoogle(storage: DurableObjectStorage) {
  await clearGoogleAccess(storage);
  return revokeGoogleCredentials(storage);
}
