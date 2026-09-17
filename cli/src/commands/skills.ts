import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { NO_SKILLS_LABEL } from "../llm/skills-constants";

type SkillsListRow = {
  name: string;
  enabled: boolean;
  description: string;
};

function token(): string {
  const value = loadConfig().accessToken;
  if (!value) throw new Error("No hay sesión. Ejecuta: chavez login");
  return value;
}

export function formatSkillsListLine(skill: SkillsListRow): string {
  return `${skill.enabled ? "on " : "off"} ${skill.name}  ${skill.description}`;
}

export async function skillsCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "list") {
    const data = await apiFetch<{ skills: SkillsListRow[] }>(
      "/skills",
      {},
      token(),
    );
    for (const skill of data.skills) console.log(formatSkillsListLine(skill));
    if (data.skills.length === 0) console.log(NO_SKILLS_LABEL);
    return;
  }
  if (action === "add") {
    const name = rest[0];
    const description = rest[1];
    const body = rest.slice(2).join(" ");
    if (!name || !description || !body) {
      throw new Error("Uso: chavez skills add <name> <description> <body…>");
    }
    const data = await apiFetch(
      "/skills",
      {
        method: "POST",
        body: JSON.stringify({ name, description, body }),
      },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "rm") {
    const id = rest[0];
    if (!id) throw new Error("Uso: chavez skills rm <id>");
    await apiFetch(`/skills/${id}`, { method: "DELETE" }, token());
    console.log("deleted");
    return;
  }
  throw new Error("Uso: chavez skills list|add|rm");
}
