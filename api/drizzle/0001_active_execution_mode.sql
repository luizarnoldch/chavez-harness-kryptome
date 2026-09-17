ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "active_execution_mode" text;
