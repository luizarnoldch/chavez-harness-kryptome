// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

const port = Number(process.env.WEB_PORT || process.env.PORT || 25002);

export default defineConfig({
  // Server mode so /workspaces/:id etc. work without empty getStaticPaths 404.
  // `astro dev` SSRs without an adapter; production build can add @astrojs/node later.
  output: "server",
  integrations: [react()],
  server: {
    port,
    host: true,
  },
  vite: {
    server: {
      port,
    },
  },
});
