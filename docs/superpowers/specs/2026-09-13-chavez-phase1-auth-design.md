# Chavez Harness — Phase 1 Auth + Provider Sync Design

**Date:** 2026-09-13

## Goal

Authenticate users to a Chavez account from the CLI (and later web), store Claude/Cursor provider credentials in the API vault, and sync those credentials across any machine that logs into the same Chavez account.

## Architecture

- `api/`: Bun + Hono + Drizzle + PostgreSQL + Better Auth (source of truth)
- `cli/`: Bun client for auth and provider management (LLM execution deferred)
- `web/`: out of scope for phase 1

## Auth

- CLI uses OAuth 2.0 Device Authorization (Better Auth)
- Browser sign-in: magic link (dev logs link to console)
- Provider linking is a vault, not Anthropic/Cursor social login for Chavez account creation

## Provider vault

- Encrypted at rest (AES-256-GCM, `PROVIDER_SECRETS_KEY`)
- Claude: `oauth_token` (from `claude setup-token`) or `api_key`
- Cursor: `api_key` (stub flow in phase 1)
- Active provider stored in `user_preferences`

## Out of scope

LLM SDK execution, WebSockets, chats, skills, subagents, full web app.
