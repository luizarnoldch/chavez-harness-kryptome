import { z } from "zod";
import {
  LISTEN_SERVICES,
  resolveAuthUrl,
  resolveListenPorts,
} from "../port";

function emptyToUndefined(value: unknown): unknown {
  if (value === "" || value === undefined || value === null) return undefined;
  return value;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().min(1),
  PROVIDER_SECRETS_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      "PROVIDER_SECRETS_KEY must be a 64-char hex string (32 bytes)",
    ),
  RESEND_FROM: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default("Chavez <onboarding@resend.dev>"),
  ),
  PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().optional(),
  ),
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "production", "test"]).optional(),
  ),
  WEB_ORIGIN: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),
});

const publicSchema = z.object({
  BETTER_AUTH_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),
});

const serverParsed = serverSchema.safeParse(process.env);
if (!serverParsed.success) {
  throw new Error(
    `Invalid server environment:\n${formatZodError(serverParsed.error)}`,
  );
}

const publicParsed = publicSchema.safeParse(process.env);
if (!publicParsed.success) {
  throw new Error(
    `Invalid public environment:\n${formatZodError(publicParsed.error)}`,
  );
}

const listenPorts = resolveListenPorts(
  LISTEN_SERVICES.length,
  serverParsed.data.PORT,
);
const listenPort = listenPorts[0]!;
const betterAuthUrl = resolveAuthUrl(
  listenPort,
  publicParsed.data.BETTER_AUTH_URL,
);

const webOrigin =
  (serverParsed.data.WEB_ORIGIN as string | undefined) ??
  "http://localhost:25002";

const trustedOrigins = Array.from(
  new Set([betterAuthUrl, webOrigin].filter(Boolean)),
);

export const env = {
  server: {
    databaseUrl: serverParsed.data.DATABASE_URL,
    betterAuthSecret: serverParsed.data.BETTER_AUTH_SECRET,
    resendApiKey: serverParsed.data.RESEND_API_KEY,
    providerSecretsKey: serverParsed.data.PROVIDER_SECRETS_KEY,
    resendFrom: serverParsed.data.RESEND_FROM as string,
    port: serverParsed.data.PORT as number | undefined,
    nodeEnv: serverParsed.data.NODE_ENV as
      | "development"
      | "production"
      | "test"
      | undefined,
    webOrigin,
  },
  public: {
    betterAuthUrl,
    listenPort,
    listenPorts,
    trustedOrigins,
    webOrigin,
  },
} as const;
