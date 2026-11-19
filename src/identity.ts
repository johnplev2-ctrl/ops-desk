// The one seam between "who is this?" and the rest of the app.
// Production: Cloudflare Access sits in front of the site and sends a signed JWT; the role comes from ROLE_MAP.
// Demo: no login; the role comes from the role-switcher cookie.

import { verifyAccessJwt, AccessJwtError, type JwksFetcher } from "./access-jwt";
import { getCookie, HttpError, log } from "./http";

export const ROLES = ["owner", "manager", "staff"] as const;
export type Role = (typeof ROLES)[number];

export interface Identity {
  role: Role;
  actor: string; // display name written to the audit log
  source: "access" | "demo";
  email?: string;
}

export const ROLE_COOKIE = "od_role";

/** Generic demo personas. Demo data only. */
export const DEMO_PERSONAS: Record<Role, string> = {
  owner: "Jordan",
  manager: "Alex",
  staff: "Sam",
};

export interface IdentityEnv {
  DEMO_MODE: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ROLE_MAP: string;
}

export function isDemo(env: Pick<IdentityEnv, "DEMO_MODE">): boolean {
  return env.DEMO_MODE !== "false";
}

export function accessConfigured(env: IdentityEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN?.trim() && env.ACCESS_AUD?.trim());
}

/** ROLE_MAP is JSON: {"ana@shop.example": "owner", "*@shop.example": "staff"}. Exact email wins over the domain wildcard. */
export function roleFromMap(roleMapJson: string, email: string): Role | null {
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(roleMapJson || "{}") as Record<string, unknown>;
  } catch {
    log("error", "role_map_invalid_json");
    return null;
  }
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) normalized[k.trim().toLowerCase()] = v;
  const e = email.trim().toLowerCase();
  const domain = e.includes("@") ? e.slice(e.lastIndexOf("@")) : "";
  const value = normalized[e] ?? (domain ? normalized[`*${domain}`] : undefined);
  return typeof value === "string" && (ROLES as readonly string[]).includes(value) ? (value as Role) : null;
}

export async function resolveIdentity(
  request: Request,
  env: IdentityEnv,
  opts: { fetchJwks?: JwksFetcher; now?: number } = {},
): Promise<Identity> {
  const assertion = request.headers.get("cf-access-jwt-assertion");

  if (assertion && accessConfigured(env)) {
    let email: string | undefined;
    try {
      const payload = await verifyAccessJwt(assertion, {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        aud: env.ACCESS_AUD.trim(),
        fetchJwks: opts.fetchJwks,
        now: opts.now,
      });
      email = typeof payload.email === "string" ? payload.email : undefined;
    } catch (err) {
      const reason = err instanceof AccessJwtError ? err.message : "verification failed";
      log("warn", "access_jwt_rejected", { reason });
      throw new HttpError(403, "access_denied", "Your Cloudflare Access session could not be verified. Sign in again.");
    }
    if (!email) throw new HttpError(403, "access_denied", "Your Access identity has no email address.");
    const role = roleFromMap(env.ROLE_MAP, email);
    if (!role) throw new HttpError(403, "no_role", "Your account has no role on this desk. Ask the owner to add you.");
    return { role, actor: email, source: "access", email };
  }

  if (!isDemo(env)) {
    // Production never falls back to a cookie: no verified Access identity, no access.
    if (!accessConfigured(env)) {
      log("error", "access_not_configured");
      throw new HttpError(500, "access_not_configured", "This desk is not connected to Cloudflare Access yet.");
    }
    throw new HttpError(401, "access_required", "Sign in through Cloudflare Access to use this desk.");
  }

  const cookieRole = getCookie(request, ROLE_COOKIE);
  const role: Role = (ROLES as readonly string[]).includes(cookieRole ?? "") ? (cookieRole as Role) : "staff";
  return { role, actor: DEMO_PERSONAS[role], source: "demo" };
}
