ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "active_params" jsonb;

CREATE TABLE IF NOT EXISTS "provider_catalogs" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "raw_json" jsonb NOT NULL,
  "fetched_at" timestamp NOT NULL DEFAULT now(),
  "last_error" text,
  CONSTRAINT "provider_catalogs_user_provider_uidx" UNIQUE ("user_id", "provider")
);
