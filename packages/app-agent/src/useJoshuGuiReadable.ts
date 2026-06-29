import { useEffect, useLayoutEffect, useRef } from "react";
import { useAgentContext } from "@copilotkit/react-core/v2";

import { useJoshuAppAgentContext } from "./JoshuAppAgentProvider.js";

export type JoshuGuiReadableInput = {
  /** Short label, e.g. "jmail.gui" */
  name: string;
  description: string;
  /** Return a JSON-serializable GUI snapshot (called on every render and before agent runs). */
  getSnapshot: () => Record<string, unknown> | undefined;
};

/** Register live GUI state for the agent via CopilotKit useAgentContext. */
export function useJoshuGuiReadable(input: JoshuGuiReadableInput): void {
  const { setGuiStateGetter } = useJoshuAppAgentContext();
  const getSnapshotRef = useRef(input.getSnapshot);
  getSnapshotRef.current = input.getSnapshot;

  useEffect(() => {
    setGuiStateGetter(() => getSnapshotRef.current());
  }, [setGuiStateGetter]);

  // Refresh CopilotKit context whenever the host app re-renders (pane/selection changes).
  useLayoutEffect(() => {
    setGuiStateGetter(() => getSnapshotRef.current());
  });

  const snapshot = getSnapshotRef.current();

  useAgentContext({
    description: `${input.name}: ${input.description}`,
    value: JSON.parse(JSON.stringify(snapshot ?? {})),
  });
}
