import { redactEnvValues, redactText } from "./redact";
import { classifyPath, loadIgnore } from "./ignore";

export function redactDiffForCwd(cwd: string, text: string): string {
  const set = loadIgnore(cwd);
  const lines = text.split("\n");
  let inSecretFile = false;
  const out: string[] = [];
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    const minus = /^--- a\/(.+)$/.exec(line);
    const file = header?.[2] || plus?.[1] || minus?.[1];
    if (file) {
      const rel = file.replace(/^\.\//, "");
      const cls = classifyPath(set, rel);
      inSecretFile = cls === "secret" || cls === "vault" || /(^|\/)\.env(\.|$)/.test(rel);
    }
    if (
      inSecretFile &&
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---")
    ) {
      out.push(line[0] + redactEnvValues(redactText(line.slice(1))));
      continue;
    }
    out.push(redactText(line));
  }
  return out.join("\n");
}
