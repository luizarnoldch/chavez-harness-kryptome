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

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  throw new Error("BETTER_AUTH_SECRET is required");
}

const resendApiKey = process.env.RESEND_API_KEY;
if (!resendApiKey) {
  throw new Error("RESEND_API_KEY is required");
}

const resend = new Resend(resendApiKey);
const resendFrom =
  process.env.RESEND_FROM ?? "Chavez <onboarding@resend.dev>";

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
  trustedOrigins: [baseURL, "http://localhost:3000"],
  emailAndPassword: {
    enabled: false,
  },
  plugins: [
    bearer(),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        const { error } = await resend.emails.send({
          from: resendFrom,
          to: email,
          subject: "Sign in to Chavez",
          html: `<p>Haz clic para iniciar sesión en Chavez:</p>
<p><a href="${url}">Iniciar sesión</a></p>
<p>Si no pediste este enlace, ignora este correo.</p>
<p style="word-break:break-all;color:#666;font-size:12px">${url}</p>`,
        });

        if (error) {
          const message = `Resend failed: ${error.message ?? JSON.stringify(error)}`;
          if (process.env.NODE_ENV === "production") {
            throw new Error(message);
          }
          console.warn(message);
        }

        if (process.env.NODE_ENV !== "production") {
          const line = `\n========== MAGIC LINK ==========\nTo: ${email}\nURL: ${url}\n================================\n`;
          console.log(line);
          await Bun.write(
            `${process.cwd()}/.dev-magic-link.txt`,
            `${email}\n${url}\n`
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
