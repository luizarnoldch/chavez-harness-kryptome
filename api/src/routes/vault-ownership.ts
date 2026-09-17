import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { providerCredentials } from "../db/schema";
import { CREDENTIALS_NOT_LINKED } from "../lib/no-team";

export { CREDENTIALS_NOT_LINKED };

export async function loadOwnedCredential(
  userId: string,
  provider: string,
) {
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, userId),
        eq(providerCredentials.provider, provider),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function credentialsMissingJson() {
  return { error: CREDENTIALS_NOT_LINKED };
}
