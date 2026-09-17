export function isCiEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CI === "1" || env.CI === "true" || env.CHAVEZ_CI === "1";
}
