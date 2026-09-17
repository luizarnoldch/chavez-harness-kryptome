import {
  filterPrompts,
  PROMPT_ACCOUNT_LABEL,
  PROMPT_EMPTY,
  PROMPT_PICKER_HEADER,
  type SavedPrompt,
} from "../lib/prompt-library";

export function PromptPicker({
  prompts,
  query,
  activeIndex,
  onHover,
  onPick,
}: {
  prompts: SavedPrompt[];
  query: string;
  activeIndex: number;
  onHover: (i: number) => void;
  onPick: (p: SavedPrompt) => void;
}) {
  const items = filterPrompts(prompts, query);
  return (
    <div className="prompt-picker" role="listbox" aria-label="Saved prompts">
      <header>
        {PROMPT_PICKER_HEADER} · {PROMPT_ACCOUNT_LABEL}
      </header>
      {items.length === 0 ? (
        <p className="muted">{PROMPT_EMPTY}</p>
      ) : (
        items.map((p, i) => (
          <button
            type="button"
            key={p.id}
            className={`pick${i === activeIndex ? " active" : ""}`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(p)}
          >
            <code>{p.name}</code> {p.title}
          </button>
        ))
      )}
    </div>
  );
}
