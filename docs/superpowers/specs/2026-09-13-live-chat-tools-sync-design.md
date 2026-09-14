# Live chat / tools sync — Design

**Date:** 2026-09-13

## Goal

While a workspace WS daemon is open, CLI and Web can interact synchronously on the same chat: view messages, tool calls, and stream deltas; send agent prompts or manual appends.

## Architecture

- **API:** persistence + fan-out (`broadcastToUser`)
- **Daemon CLI:** Agent SDK runner (`clientKind: daemon`)
- **Web / headless / TUI:** push-aware clients

## Protocol

- `chat.append` → persist + push `message.appended`
- `chat.stream.*` / `chat.tool.*` from daemon → persist (tools + final assistant) + push
- `agent.turn.request` (any client) → `agent.turn.dispatch` to daemon

## Data

`chat_messages.role`: user | assistant | system | tool  
`chat_messages.metadata`: JSON (toolName, toolCallId, status, input, output, streamId)
