#!/usr/bin/env bun
import { join } from "node:path";
import { loginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { whoamiCommand } from "./commands/whoami";
import { providerCommand } from "./commands/provider";
import { headlessCommand } from "./commands/headless";
import { modeCommand } from "./commands/mode";
import { modelCommand } from "./commands/model";
import { rulesCommand } from "./commands/rules";
import { skillsCommand } from "./commands/skills";
import { memoryCommand } from "./commands/memory";
import { promptCommand } from "./commands/prompt";
import { ciCommand } from "./commands/ci";
import { assertCanOpenTui } from "./ci/guards";
import { CiCliError } from "./ci/errors";
import { collectCiSecrets, redactCiLog } from "./ci/redact-log";
import { cwdPath } from "./workspace";
import { loadConfig } from "./config";
import { EXPORT_HUB_HINT } from "./chats/export-share";

function usage(exitCode = 0): never {
  console.log(`Chavez CLI

cwd: ${cwdPath()}

Usage:
  chavez login
  chavez logout
  chavez whoami
  chavez provider list|status          # linked, runnable, activo (sin secrets)
  chavez provider set <claude|cursor>
  chavez provider link claude              # OAuth vía claude setup-token
  chavez provider link claude --api-key    # API key por prompt
  chavez provider link cursor              # API key por prompt
  chavez provider link cursor --web        # formulario web
  chavez provider link github              # PAT ghp_ / github_pat_
  chavez provider unlink <claude|cursor|github>
  chavez tui                               # vista interactiva (Ink); tecla t abre PTY
  chavez mode [plan|auto|ask]
  chavez model [id]
  chavez rules list|add|enable|disable|rm
  chavez skills list|add|rm
  chavez memory list|add|rm
  chavez prompt list [--json]
  chavez prompt save <name> [body…]
  chavez prompt get <name>
  chavez prompt rm <name>
  chavez ci [--mode auto|plan] [--chat <chatId>] [--timeout <ms>] [--ci] <prompt…>
  chavez headless rules project|local|workspace
  chavez headless mcp status
  chavez headless skills
  chavez headless memory list|add|rm
  chavez headless workspace open|close|status
  chavez headless worktree list|add|select|status
  chavez headless session create|list
  chavez headless chat create|list|append|get|ask|watch|dump|queue|dequeue|search|pin|unpin|archive|unarchive|rename|move|steer|cancel|plan|compact|undo|cost|clear|retry|diffs|diff|export|import|share
  chavez headless chat export <chatId> [--format md|json] [--out file]
  chavez headless chat import <sessionId> <file.json>
  chavez headless chat share create|get|revoke <chatId>
  chavez headless chat dump <chatId> [streamId]
  chavez headless chat plan list|get|update|current|apply <chatId> …
  chavez headless chat compact <chatId>
  chavez headless chat ask [--no-queue] [--wait-timeout <ms>] [--mode plan|auto|ask] [--provider claude|cursor] [--model <id>] [--prompt <name>] [--ci] [--timeout <ms>] <chatId> [texto…]
  chavez headless chat review <chatId> [pr|#n] [--publish]
  chavez headless chat approve <chatId> <toolCallId>
  chavez headless chat deny <chatId> <toolCallId>
  chavez headless chat watch <chatId>   # y/n si TTY; nunca auto-aprueba
  chavez headless chat ask <chatId> 'explica @src/app.ts'  # daemon hidrata @
  chavez headless git status|diff|commit|push|pr|branch
  chavez headless connections              # sockets WS abiertos (HTTP)
  ${EXPORT_HUB_HINT}
  Primer uso: chavez login → provider link claude → tui | headless workspace open → chat ask
`);
  process.exit(exitCode);
}

async function tuiCommand(): Promise<void> {
  assertCanOpenTui();
  const config = loadConfig();
  if (!config.accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
  const tuiEntry = join(import.meta.dir, "../../tui/src/index.tsx");
  const proc = Bun.spawn(
    ["bun", "run", tuiEntry],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        CHAVEZ_API_URL: config.apiUrl,
        CHAVEZ_ACCESS_TOKEN: config.accessToken,
        CHAVEZ_CWD: cwdPath(),
      },
    }
  );
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage(1);

  try {
    switch (cmd) {
      case "login":
        await loginCommand();
        break;
      case "logout":
        await logoutCommand();
        break;
      case "whoami":
        await whoamiCommand();
        break;
      case "provider":
        await providerCommand(rest);
        break;
      case "mode":
        await modeCommand(rest);
        break;
      case "model":
        await modelCommand(rest);
        break;
      case "rules":
        await rulesCommand(rest);
        break;
      case "skills":
        await skillsCommand(rest);
        break;
      case "memory":
        await memoryCommand(rest);
        break;
      case "prompt":
        await promptCommand(rest);
        break;
      case "headless":
        await headlessCommand(rest);
        break;
      case "ci":
        await ciCommand(rest);
        break;
      case "tui":
        await tuiCommand();
        break;
      case "help":
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        console.error(`Comando desconocido: ${cmd}`);
        usage(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(redactCiLog(message, collectCiSecrets()));
    const code = err instanceof CiCliError ? err.exitCode : 1;
    process.exit(code);
  }
}

main();
