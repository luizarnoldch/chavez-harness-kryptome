CREATE TABLE IF NOT EXISTS "saved_prompts" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "saved_prompts_user_name_uidx"
  ON "saved_prompts" ("user_id", "name");
