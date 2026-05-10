import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";

/**
 * Cloudflare Access JWT middleware.
 *
 * Verifies the `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie)
 * against the team's JWKS endpoint. Skipped entirely when DEV_AGENT_TRUST_LOCAL=1.
 *
 * Sets `c.set("user", { email, sub })` on success.
 */
export interface CfAccessUser {
  email?: string;
  sub: string;
}

interface AuthOpts {
  teamDomain: string; // e.g. "yourteam"
  audience: string;
  trustLocal: boolean;
}

export function cfAccessAuth(opts: AuthOpts): MiddlewareHandler {
  if (opts.trustLocal) {
    return async (c, next) => {
      c.set("user", { sub: "local-dev", email: "local@dev" } satisfies CfAccessUser);
      await next();
    };
  }

  if (!opts.teamDomain || !opts.audience) {
    throw new Error(
      "CF Access auth requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (or set DEV_AGENT_TRUST_LOCAL=1)",
    );
  }

  const issuer = `https://${opts.teamDomain}.cloudflareaccess.com`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async (c, next) => {
    const token =
      c.req.header("cf-access-jwt-assertion") ?? extractCookie(c.req.header("cookie"));
    if (!token) {
      return c.json({ error: "missing CF Access token" }, 401);
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: opts.audience,
      });
      c.set("user", {
        sub: String(payload.sub ?? ""),
        email: typeof payload.email === "string" ? payload.email : undefined,
      } satisfies CfAccessUser);
      await next();
    } catch (err) {
      return c.json({ error: "invalid CF Access token", detail: (err as Error).message }, 401);
    }
  };
}

function extractCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "CF_Authorization") return rest.join("=");
  }
  return null;
}
