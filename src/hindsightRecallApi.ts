/**
 * Hindsight recall for apps — semantic search over conversation memory bank.
 */

import type { Request, Response, Router } from "express";

export function registerHindsightRecallRoute(
  router: Router,
  deps: {
    hindsightApiUrl: string;
    hindsightApiKey: string;
    bankId: string;
    proxyHindsightJson: (
      pathname: string,
      query?: URLSearchParams,
    ) => Promise<{ status: number; body: unknown }>;
  },
): void {
  router.get("/api/hindsight/recall", async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ error: "q is required" });

    const limit = typeof req.query.limit === "string" ? req.query.limit : "10";
    const query = new URLSearchParams({ q, limit });
    const bankId = deps.bankId || "joshu";

    // Hindsight recall API — query memories in bank
    const pathname = `v1/default/banks/${encodeURIComponent(bankId)}/memories/search`;
    query.set("query", q);
    if (limit) query.set("limit", limit);

    try {
      const upstream = await deps.proxyHindsightJson(pathname, query);
      return res.status(upstream.status).json(upstream.body);
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
