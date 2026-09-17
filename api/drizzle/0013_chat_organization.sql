ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "title_source" text NOT NULL DEFAULT 'default';
ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "pinned_at" timestamp;
ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp;

CREATE INDEX IF NOT EXISTS "chats_user_session_updated_idx"
  ON "chats" ("user_id", "session_id", "updated_at");
CREATE INDEX IF NOT EXISTS "chats_user_archived_pinned_idx"
  ON "chats" ("user_id", "archived_at", "pinned_at");
CREATE INDEX IF NOT EXISTS "chat_messages_chat_role_idx"
  ON "chat_messages" ("chat_id", "role");
