import { redactText } from "../llm/redact";
import { redactSecrets, truncateToolText } from "../llm/tool-display";
import { PTY_TRANSCRIPT_MAX_CHARS } from "./constants";

const SECRET_VALUE_RE =
  /sk-ant-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|CHAVEZ_ACCESS_TOKEN=.+/g;

export function persistPtyTranscript(raw: string, max = PTY_TRANSCRIPT_MAX_CHARS): string {
  let text = raw.replace(SECRET_VALUE_RE, "***");
  text = redactSecrets(text);
  text = redactText(text);
  return truncateToolText(text, max);
}
