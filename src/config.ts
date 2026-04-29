export interface Config {
  baseUrl: string;
  token: string;
  userId: string;
  outputDir: string;
}

export function loadConfig(): Config {
  const token = Bun.env.GOCLAW_GATEWAY_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "GOCLAW_GATEWAY_TOKEN is not set. Copy .env.example to .env and fill it in.",
    );
  }

  const baseUrl = (Bun.env.GOCLAW_BASE_URL ?? "http://localhost:18790")
    .trim()
    .replace(/\/+$/, "");

  const userId = Bun.env.GOCLAW_USER_ID?.trim() || "system";

  const outputDir = Bun.env.GOCLAW_OUTPUT_DIR?.trim() || "goclaw";

  return { baseUrl, token, userId, outputDir };
}
