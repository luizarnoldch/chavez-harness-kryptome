export function takeFlag(
  args: string[],
  name: string,
): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      value = args[++i];
      continue;
    }
    rest.push(args[i]!);
  }
  return { value, rest };
}

export function parseAskArgs(rest: string[]): {
  mode?: string;
  provider?: string;
  model?: string;
  chatId?: string;
  prompt: string;
} {
  let filtered = rest;
  const mode = takeFlag(filtered, "--mode");
  filtered = mode.rest;
  const provider = takeFlag(filtered, "--provider");
  filtered = provider.rest;
  const model = takeFlag(filtered, "--model");
  filtered = model.rest;
  return {
    mode: mode.value,
    provider: provider.value,
    model: model.value,
    chatId: filtered[0],
    prompt: filtered.slice(1).join(" "),
  };
}
