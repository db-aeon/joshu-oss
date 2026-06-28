/** Shared platform-data types. */

export type DataTier = "cache" | "live" | "sync";

export type MailProvider = "nylas" | "gmail";

export type PlatformDataClientOptions = {
  /** Joshu API root, e.g. `/joshu/api` or `http://127.0.0.1:8788/joshu/api` */
  apiBase?: string;
  fetch?: typeof fetch;
};

export type ConnectorsStatus = {
  nylas?: {
    configured?: boolean;
    provisioned?: boolean;
    email?: string;
    mirror?: { threadCount: number; empty: boolean };
  };
  gmail?: {
    enabled?: boolean;
    connected?: boolean;
    email?: string;
    accounts?: Array<{
      connectedAccountId: string;
      accountKey: string;
      email?: string;
      label?: string;
      isDefault?: boolean;
    }>;
    mirror?: { threadCount: number; empty: boolean };
  };
  registry?: Record<string, unknown>;
};

export type MailSearchHit = {
  threadId?: string;
  messageId?: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet?: string;
  [key: string]: unknown;
};

export type FilesQueryResult = {
  query: string;
  answer: string;
  hit_count: number;
  lane?: string;
};

export type NylasStatus = {
  configured: boolean;
  agent: {
    provisioned: boolean;
    grantId?: string;
    email?: string;
    createdAt?: string;
  };
};
