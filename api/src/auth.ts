import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  bearer,
  deviceAuthorization,
  magicLink,
} from "better-auth/plugins";
import { Resend } from "resend";
import { db } from "./db";
import * as schema from "./db/schema";
import { env } from "./lib/config";

const baseURL = env.public.betterAuthUrl;
const secret = env.server.betterAuthSecret;
const resend = new Resend(env.server.resendApiKey);
const resendFrom = env.server.resendFrom;
const secureCookies = baseURL.startsWith("https://");

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      deviceCode: schema.deviceCode,
    },
  }),
  baseURL,
  secret,
  trustedOrigins: [...env.public.trustedOrigins],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["credential"],
      allowDifferentEmails: false,
    },
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      path: "/",
    },
  },
  plugins: [
    bearer(),
    magicLink({
      // Same email: first click creates the user; later clicks sign in.
      disableSignUp: false,
      sendMagicLink: async ({ email, url }) => {
        const to = email.trim().toLowerCase();
        const { error } = await resend.emails.send({
          from: resendFrom,
          to,
          subject: "Sign in to Chavez",
          html: `<p>Haz clic para iniciar sesión en Chavez:</p>
<p><a href="${url}">Iniciar sesión</a></p>
<p>Si no pediste este enlace, ignora este correo.</p>
<p style="word-break:break-all;color:#666;font-size:12px">${url}</p>`,
        });

        if (error) {
          const message = `Resend failed: ${error.message ?? JSON.stringify(error)}`;
          if (env.server.nodeEnv === "production") {
            throw new Error(message);
          }
          console.warn(message);
        }

        if (env.server.nodeEnv !== "production") {
          const line = `\n========== MAGIC LINK ==========\nTo: ${to}\nURL: ${url}\n================================\n`;
          console.log(line);
          await Bun.write(
            `${process.cwd()}/.dev-magic-link.txt`,
            `${to}\n${url}\n`
          );
        }
      },
    }),
    deviceAuthorization({
      verificationUri: "/device",
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
