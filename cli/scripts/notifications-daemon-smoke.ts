/**
 * Gherkin: Daemon caído → sin runner; desaparece al reconnect (plan 17).
 * Sin heartbeat real: inyecta daemon.presence en el store (mismo classifier
 * que onPush) y, si el handler ya broadcast presence, también lo espera.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { NO_RUNNER_LABEL } from "../src/notifications/constants";
import {
  emptyNotificationState,
  hasDaemonDown,
  reduceNotification,
} from "../src/notifications/store";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const path = process.cwd().replace(/\\/g, "/");
const daemon = new ChavezWsClient(token);
const viewer = new ChavezWsClient(token);
await daemon.connect();
await viewer.connect();

let s = emptyNotificationState();
viewer.onPush((msg) => {
  s = reduceNotification(
    s,
    { type: msg.type, data: msg.data },
    { surface: "web", activeChatId: null, now: Date.now() },
  ).state;
});

const bind = await daemon.bind(path, "daemon");
if (!bind.ok) throw new Error(bind.error || "bind failed");
const workspaceId = (bind.data as { workspace?: { id: string } })?.workspace?.id;

s = reduceNotification(
  s,
  { type: "daemon.presence", data: { bound: true, workspaceId } },
  { surface: "web", activeChatId: null, now: Date.now() },
).state;
if (hasDaemonDown(s)) throw new Error("bound must clear sin runner");

s = reduceNotification(
  s,
  { type: "daemon.presence", data: { bound: false, workspaceId } },
  { surface: "web", activeChatId: null, now: Date.now() },
).state;
if (!hasDaemonDown(s)) throw new Error("expected sin runner");
if (s.items.find((i) => i.kind === "daemon")?.title !== NO_RUNNER_LABEL) {
  throw new Error(`label must be ${NO_RUNNER_LABEL}`);
}

s = reduceNotification(
  s,
  { type: "daemon.presence", data: { bound: true, workspaceId } },
  { surface: "web", activeChatId: null, now: Date.now() },
).state;
if (hasDaemonDown(s)) throw new Error("reconnect must drop sin runner");

daemon.close();
viewer.close();
console.log("SMOKE PASS notifications-daemon (sin runner ↔ reconnect)");
