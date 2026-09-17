CREATE TABLE IF NOT EXISTS "memories" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "workspace_id" text REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "title" text NOT NULL,
  "fact" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "memories_user_id_id_uidx"
  ON "memories" ("user_id", "id");

CREATE INDEX IF NOT EXISTS "memories_user_scope_ws_idx"
  ON "memories" ("user_id", "scope", "workspace_id");
