import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChavezConfig = {
  apiUrl: string;
  accessToken?: string;
};

const DIR = join(homedir(), ".chavez");
const FILE = join(DIR, "config.json");

export function defaultApiUrl(): string {
  return process.env.CHAVEZ_API_URL || "http://localhost:3000";
}

export function loadConfig(): ChavezConfig {
  const fromFile = existsSync(FILE)
    ? (JSON.parse(readFileSync(FILE, "utf8")) as ChavezConfig)
    : { apiUrl: defaultApiUrl() };
  return {
    apiUrl: process.env.CHAVEZ_API_URL || fromFile.apiUrl || defaultApiUrl(),
    accessToken: process.env.CHAVEZ_ACCESS_TOKEN || fromFile.accessToken,
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
