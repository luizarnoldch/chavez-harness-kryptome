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
  CHAVEZ_API_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default("http://localhost:25001"),
  ),
});

const serverSchema = z.object({
  CHAVEZ_ACCESS_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  CHAVEZ_WS_DAEMON_LOG: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  CLAUDE_CONFIG_DIR: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
});

const publicParsed = publicSchema.safeParse(process.env);
if (!publicParsed.success) {
  throw new Error(
    `Invalid public environment:\n${formatZodError(publicParsed.error)}`,
  );
}

const serverParsed = serverSchema.safeParse(process.env);
if (!serverParsed.success) {
  throw new Error(
    `Invalid server environment:\n${formatZodError(serverParsed.error)}`,
  );
}

export const env = {
  public: {
    chavezApiUrl: publicParsed.data.CHAVEZ_API_URL as string,
  },
  server: {
    accessToken: serverParsed.data.CHAVEZ_ACCESS_TOKEN as string | undefined,
    wsDaemonLog: serverParsed.data.CHAVEZ_WS_DAEMON_LOG as string | undefined,
    claudeConfigDir: serverParsed.data.CLAUDE_CONFIG_DIR as string | undefined,
  },
} as const;
