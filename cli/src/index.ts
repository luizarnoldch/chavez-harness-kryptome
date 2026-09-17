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
import { cwdPath } from "./workspace";
import { loadConfig } from "./config";

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
  chavez tui                               # vista interactiva (Ink)
  chavez mode [plan|auto|ask]
  chavez model [id]
  chavez rules list|add|enable|disable|rm
  chavez skills list|add|rm
  chavez headless rules project|local|workspace
  chavez headless mcp status
  chavez headless skills
  chavez headless workspace open|close|status
  chavez headless session create|list
  chavez headless chat create|list|append|get|ask|watch|steer|cancel|plan|compact|undo|cost|clear|retry|diffs|diff
  chavez headless chat plan list|get|update|current|apply <chatId> …
  chavez headless chat compact <chatId>
  chavez headless chat ask [--mode plan|auto|ask] [--provider claude|cursor] [--model <id>] <chatId> <prompt…>
  chavez headless chat approve <chatId> <toolCallId>
  chavez headless chat deny <chatId> <toolCallId>
  chavez headless chat watch <chatId>   # y/n si TTY; nunca auto-aprueba
  chavez headless chat ask <chatId> 'explica @src/app.ts'  # daemon hidrata @
  chavez headless git status|diff|commit|push|pr|branch
  chavez headless connections              # sockets WS abiertos (HTTP)
  Primer uso: chavez login → provider link claude → tui | headless workspace open → chat ask
`);
  process.exit(exitCode);
}

async function tuiCommand(): Promise<void> {
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
      case "headless":
        await headlessCommand(rest);
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
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
