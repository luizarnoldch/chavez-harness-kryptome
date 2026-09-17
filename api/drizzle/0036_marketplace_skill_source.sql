ALTER TABLE "user_skills" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';
ALTER TABLE "user_skills" ADD COLUMN IF NOT EXISTS "catalog_id" text;
