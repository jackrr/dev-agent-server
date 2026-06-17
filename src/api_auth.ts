import type { MiddlewareHandler } from "hono";

export function apiKeyAuth(): MiddlewareHandler {
  return async (c, next) => {
    const apiKey = c.req.header("x-api-key");
    const expectedKey = process.env.API_KEY;

    if (!expectedKey) {
      // If no API key is configured on the server, allow all for now in dev,
      // but in production we should probably require it.
      return await next();
    }

    if (apiKey !== expectedKey) {
      return c.json({ error: "Unauthorized: Invalid API Key" }, 401);
    }

    await next();
  };
}
