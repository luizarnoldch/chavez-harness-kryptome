import React from "react";
import { render } from "ink";
import { App } from "./App";
import { isTuiForbidden } from "../../cli/src/ci/detect";
import { TUI_NO_TTY } from "../../cli/src/ci/constants";

if (isTuiForbidden()) {
  console.error(TUI_NO_TTY);
  process.exit(1);
}

render(<App />);
