ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "onboarding_status" text;
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp;
