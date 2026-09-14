import { z } from "zod";

function emptyToUndefined(value: unknown): unknown {
  if (value === "" || value === undefined || value === null) return undefined;
  return value;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

const publicSchema = z.object({
  PUBLIC_CHAVEZ_API_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default("http://localhost:25001"),
  ),
  PUBLIC_WEB_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default("http://localhost:25002"),
  ),
});

// Client-safe: only import.meta.env (PUBLIC_*). Never touch process.env —
// Vite browser bundles have no `process` and crash island hydration.
const parsed = publicSchema.safeParse({
  PUBLIC_CHAVEZ_API_URL: import.meta.env.PUBLIC_CHAVEZ_API_URL,
  PUBLIC_WEB_URL: import.meta.env.PUBLIC_WEB_URL,
});

if (!parsed.success) {
  throw new Error(
    `Invalid web public environment:\n${formatZodError(parsed.error)}`,
  );
}

function portFromUrl(url: string, fallback: number): number {
  try {
    return Number(new URL(url).port) || fallback;
  } catch {
    return fallback;
  }
}

const webUrl = parsed.data.PUBLIC_WEB_URL as string;
const webPort = portFromUrl(webUrl, 25002);

export const env = {
  public: {
    apiUrl: parsed.data.PUBLIC_CHAVEZ_API_URL as string,
    webUrl,
    webPort,
  },
} as const;
