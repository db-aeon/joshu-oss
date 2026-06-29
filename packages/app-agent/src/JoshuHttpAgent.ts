import { HttpAgent, type HttpAgentConfig, type RunAgentInput } from "@ag-ui/client";

import { handleAgUiSseDataLine } from "./appGuiActionDispatch.js";
import type { JoshuAppAgentState } from "./types.js";

export type JoshuHttpAgentConfig = HttpAgentConfig & {
  appId: string;
  getAppState?: () => JoshuAppAgentState["gui"];
  mode?: JoshuAppAgentState["mode"];
};

/** HttpAgent that injects Joshu app context (appId + GUI snapshot) on every run. */
export class JoshuHttpAgent extends HttpAgent {
  private readonly appId: string;
  private readonly getAppState?: () => JoshuAppAgentState["gui"];
  private readonly mode: JoshuAppAgentState["mode"];

  constructor(config: JoshuHttpAgentConfig) {
    super(config);
    this.appId = config.appId;
    this.getAppState = config.getAppState;
    this.mode = config.mode ?? "embedded";
  }

  protected requestInit(input: RunAgentInput): RequestInit {
    const init = super.requestInit(input);
    const bodyText = typeof init.body === "string" ? init.body : "";
    let payload: Record<string, unknown> = {};
    try {
      payload = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }

    const existingState =
      payload.state && typeof payload.state === "object"
        ? (payload.state as Record<string, unknown>)
        : {};

    payload.state = {
      ...existingState,
      appId: this.appId,
      mode: this.mode,
      gui: this.getAppState?.() ?? existingState.gui,
    };

    return {
      ...init,
      body: JSON.stringify(payload),
    };
  }

  /** Tee AG-UI SSE so app_gui_action CUSTOM events run local GUI handlers. */
  run(input: RunAgentInput): ReturnType<HttpAgent["run"]> {
    const baseRun = super.run(input);
    if (!baseRun || typeof (baseRun as { subscribe?: unknown }).subscribe !== "function") {
      return baseRun;
    }

    return new Proxy(baseRun as object, {
      get(target, prop, receiver) {
        if (prop === "subscribe") {
          return (observer: { next?: (value: unknown) => void; error?: (err: unknown) => void; complete?: () => void }) => {
            const inner = (target as { subscribe: (o: typeof observer) => { unsubscribe?: () => void } }).subscribe({
              next: (value) => {
                void (async () => {
                  if (value && typeof value === "object" && "type" in (value as object)) {
                    await handleAgUiSseDataLine(`data: ${JSON.stringify(value)}`);
                  }
                })();
                observer.next?.(value);
              },
              error: (err) => observer.error?.(err),
              complete: () => observer.complete?.(),
            });
            return inner;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ReturnType<HttpAgent["run"]>;
  }
}
