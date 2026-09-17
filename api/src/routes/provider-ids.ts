export type LlmProviderId = "claude" | "cursor";
export type VaultProviderId = LlmProviderId | "github";
export type ProviderId = LlmProviderId;

export const LLM_PROVIDERS: LlmProviderId[] = ["claude", "cursor"];
export const VAULT_PROVIDERS: VaultProviderId[] = ["claude", "cursor", "github"];

export function isLlmProvider(v: string): v is LlmProviderId {
  return LLM_PROVIDERS.includes(v as LlmProviderId);
}

export function isVaultProvider(v: string): v is VaultProviderId {
  return VAULT_PROVIDERS.includes(v as VaultProviderId);
}
