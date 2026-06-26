/** Public Joshu API base for owner approval links (Slack URL buttons). */
export function resolveJoshuPublicApiBase(): string {
  const explicit =
    process.env.JOSHU_OWNER_CHANNEL_PUBLIC_URL?.trim() ||
    process.env.JOSHU_PUBLIC_URL?.trim() ||
    process.env.HERMES_DASHBOARD_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const domain = process.env.CUSTOMER_DOMAIN?.trim();
  if (domain) {
    const basePath = (process.env.PUBLIC_BASE_PATH ?? "/joshu").replace(/\/+$/, "") || "";
    return `https://${domain}${basePath}`.replace(/\/+$/, "");
  }

  const port = process.env.JOSHU_PORT?.trim() || process.env.PORT?.trim() || "8788";
  const basePath = (process.env.PUBLIC_BASE_PATH ?? "/joshu").replace(/\/+$/, "") || "/joshu";
  return `http://127.0.0.1:${port}${basePath}`.replace(/\/+$/, "");
}
