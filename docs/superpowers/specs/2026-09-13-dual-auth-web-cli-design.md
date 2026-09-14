# Chavez — Dual Auth (CLI + Web) Design

**Date:** 2026-09-13

## Goal

Authenticate the same Chavez account by email via:

1. **CLI:** device authorization + browser magic link or email/password → cookie in browser + Bearer in `~/.chavez/config.json`
2. **Web:** email + password (sign-up / sign-in) and magic link → session cookie

Then link provider credentials (Claude / Cursor) in the Web hub.

## Architecture

- Better Auth remains source of truth (`api/`)
- Identity key: normalized email (no separate username)
- Plugins: `emailAndPassword`, `magicLink`, `bearer`, `deviceAuthorization`
- Cookies set on API origin (`http://localhost:25001`); Web (`:25002`) sends them with `credentials: "include"`
- Fixed ports: Postgres 25000 · API 25001 · Web 25002 (no silent port fallback that desyncs env)

## Auth sync (magic ↔ password)

- Same email = same `user` row
- Magic-link-only account: after session, `POST /me/password` (wraps Better Auth `setPassword`) adds credential
- Password-only account: magic link with same email signs into the same user
- Sign-up with an email that already exists returns a clear error (use sign-in / set password)

## Web UI

- `/sign-in`: password (sign-in + sign-up) + magic link sections
- Hub/nav: show session email + sign-out
- `/providers`: gated by session cookie (`useMe`); `?token=` remains escape hatch

## Out of scope

- Same-origin proxy
- Username distinct from email
- Social OAuth as Chavez identity
