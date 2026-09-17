ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "active_execution_mode" text;
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "last_runnable_execution_mode" text;
