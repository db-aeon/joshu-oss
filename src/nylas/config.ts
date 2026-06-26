export function nylasApiKey(): string | null {
  const key = process.env.NYLAS_API_KEY?.trim();
  return key || null;
}

export function nylasApiUri(): string {
  return (process.env.NYLAS_API_URI?.trim() || "https://api.us.nylas.com").replace(/\/+$/, "");
}

export function isNylasConfigured(): boolean {
  return Boolean(nylasApiKey());
}
