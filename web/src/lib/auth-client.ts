import { createAuthClient } from "better-auth/client";
import { magicLinkClient } from "better-auth/client/plugins";
import { env } from "./config";

export const authClient = createAuthClient({
  baseURL: env.public.apiUrl,
  fetchOptions: {
    credentials: "include",
  },
  plugins: [magicLinkClient()],
});
