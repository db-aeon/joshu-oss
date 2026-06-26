export interface RunEvent {
  ts: string;
  stream: "stdout" | "stderr" | "system" | "final";
  text: string;
}

export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  prompt: string;
  initialUrl?: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  finalResponse?: string;
  sessionId?: string;
  events: RunEvent[];
}

export interface StatusReport {
  hermes: {
    available: boolean;
    binary: string;
    version?: string;
    error?: string;
  };
  camofox: {
    reachable: boolean;
    url: string;
    health?: unknown;
    error?: string;
  };
  docker?: {
    enabled: boolean;
    containerName: string;
    running?: boolean;
    status?: string;
    lastError?: string;
    restarting?: boolean;
  };
  novnc: {
    embedUrl: string;
    baseUrl: string;
    clientBaseUrl: string;
    websocketPath: string;
  };
  browserViewport?: {
    width: number;
    height: number;
  };
  activeSessionId?: string;
  lastBrowserUrl?: string;
  lastCamofoxUserId?: string;
}

export interface CreateRunRequest {
  prompt: string;
  initialUrl?: string;
  conversationId?: string;
}

export interface CreateRunResponse {
  runId: string;
}
