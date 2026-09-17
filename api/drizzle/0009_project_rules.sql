CREATE TABLE IF NOT EXISTS "user_rules" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "disallow_tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "allow_tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_rules_user_id_id_uidx"
  ON "user_rules" ("user_id", "id");

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "user_rules_enabled" boolean NOT NULL DEFAULT true;
