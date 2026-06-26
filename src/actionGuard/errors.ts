/** Action guard cannot notify owner (misconfig) — callers should fail closed without crashing Joshu. */
export class ActionGuardUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionGuardUnavailableError";
    this.code = code;
  }
}

export function isActionGuardUnavailableError(err: unknown): err is ActionGuardUnavailableError {
  return err instanceof ActionGuardUnavailableError;
}
