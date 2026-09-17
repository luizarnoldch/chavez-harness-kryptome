import {
  DEFAULT_EXECUTION_MODE,
  isExecutionMode,
  type ExecutionMode,
} from "../llm/execution-mode";

export function resolveCiDispatchMode(
  ci: boolean,
  activeExecutionMode: unknown,
): ExecutionMode {
  if (isExecutionMode(activeExecutionMode)) return activeExecutionMode;
  return ci ? "auto" : DEFAULT_EXECUTION_MODE;
}
