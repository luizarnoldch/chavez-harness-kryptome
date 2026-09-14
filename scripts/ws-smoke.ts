import { loadConfig } from "../cli/src/config";
import { ChavezWsClient } from "../cli/src/ws/client";
import { cwdPath } from "../cli/src/workspace";

const config = loadConfig();
if (!config.accessToken) {
  console.error("Need chavez login first");
  process.exit(1);
}

const client = new ChavezWsClient(config.accessToken);
await client.connect();
const path = cwdPath();
console.log("cwd", path);
const bound = await client.bind(path);
console.log("bind", bound.ok, bound.error || bound.data);
const session = await client.request({
  type: "session.create",
  title: "ws-smoke",
});
console.log("session", session.ok, session.data);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await client.request({
  type: "chat.create",
  sessionId,
  title: "smoke-chat",
});
console.log("chat", chat.ok, chat.data);
const chatId = (chat.data as { chat: { id: string } }).chat.id;
const append = await client.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "hola workspace",
});
console.log("append", append.ok);
const get = await client.request({ type: "chat.get", chatId });
console.log("get", get.ok, (get.data as { messages: unknown[] }).messages?.length);
client.close();
console.log("WS SMOKE PASS");
