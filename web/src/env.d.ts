/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_CHAVEZ_API_URL?: string;
  readonly PUBLIC_WEB_URL?: string;
  readonly WEB_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
