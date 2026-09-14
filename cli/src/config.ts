import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "./lib/config";

export type ChavezConfig = {
  apiUrl: string;
  accessToken?: string;
};

const DIR = join(homedir(), ".chavez");
const FILE = join(DIR, "config.json");

export function defaultApiUrl(): string {
  return env.public.chavezApiUrl;
}

export function loadConfig(): ChavezConfig {
  const fromFile = existsSync(FILE)
    ? (JSON.parse(readFileSync(FILE, "utf8")) as ChavezConfig)
    : { apiUrl: defaultApiUrl() };
  return {
    apiUrl: process.env.CHAVEZ_API_URL
      ? env.public.chavezApiUrl
      : fromFile.apiUrl || defaultApiUrl(),
    accessToken: process.env.CHAVEZ_ACCESS_TOKEN
      ? env.server.accessToken
      : fromFile.accessToken ?? env.server.accessToken,
  };
}

export function saveConfig(config: ChavezConfig): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function clearConfig(): void {
  if (existsSync(FILE)) unlinkSync(FILE);
}

export function configPath(): string {
  return FILE;
}
