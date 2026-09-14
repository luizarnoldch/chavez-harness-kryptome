# Dual Auth Web + CLI Implementation Plan

> **For agentic workers:** Use executing-plans or subagent-driven-development task-by-task.

**Goal:** Dual auth (CLI device+magic/password; Web email+password+magic) on one email account; hub shows session and can link providers.

**Architecture:** Better Auth dual methods; fixed ports 25000/25001/25002; cookies on API origin with CORS credentials.

**Tech Stack:** Bun, Hono, Better Auth, Astro/React, Drizzle

## Tasks

1. Spec (this folder + design doc) — done with implementation kickoff
2. Enable `emailAndPassword`, cookie attrs, account linking in `api/src/auth.ts`; add `POST /me/password`
3. Align ports: fail if 25001 busy instead of silent 26001 fallback
4. Web SignInForm + hooks for password/magic
5. Hub/nav session + ProvidersPanel gate
6. CLI login copy
7. E2E + README
