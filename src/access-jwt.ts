// Verifies the Cloudflare Access JWT sent in the Cf-Access-Jwt-Assertion header.
// Reference: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
// RS256, keys from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, checks aud, iss, exp, nbf.

import { base64urlDecode } from "./http";

export interface AccessJwk extends JsonWebKey {
  kid: string;
}

export type JwksFetcher = (certsUrl: string) => Promise<AccessJwk[]>;

export interface AccessPayload {
  aud: string | string[];
  iss: string;
  exp: number;
  nbf?: number;
  iat?: number;
  email?: string;
  sub?: string;
  [claim: string]: unknown;
}

export interface VerifyOptions {
  teamDomain: string;
  aud: string;
  now?: number; // epoch ms
  fetchJwks?: JwksFetcher;
}

export class AccessJwtError extends Error {}

const LEEWAY_SECONDS = 60;

// Public keys only, keyed by certs URL. Not request state; safe to reuse across requests in an isolate.
const jwksCache = new Map<string, { keys: AccessJwk[]; until: number }>();

export function normalizeTeamDomain(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/+$/, "");
  return trimmed.startsWith("https://") ? trimmed : `https://${trimmed.replace(/^http:\/\//, "")}`;
}

const defaultFetchJwks: JwksFetcher = async (certsUrl) => {
  const cached = jwksCache.get(certsUrl);
  if (cached && cached.until > Date.now()) return cached.keys;
  const res = await fetch(certsUrl, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AccessJwtError(`certs endpoint returned ${res.status}`);
  const body = (await res.json()) as { keys?: AccessJwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(certsUrl, { keys, until: Date.now() + 10 * 60_000 });
  return keys;
};

function decodePart<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(part))) as T;
  } catch {
    throw new AccessJwtError("malformed token");
  }
}

export async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<AccessPayload> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new AccessJwtError("malformed token");
  const [h, p, s] = parts;
  const header = decodePart<{ alg?: string; kid?: string }>(h);
  if (header.alg !== "RS256") throw new AccessJwtError("unexpected algorithm");
  if (!header.kid) throw new AccessJwtError("missing kid");

  const issuer = normalizeTeamDomain(opts.teamDomain);
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const keys = await (opts.fetchJwks ?? defaultFetchJwks)(certsUrl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessJwtError("unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64urlDecode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new AccessJwtError("bad signature");

  const payload = decodePart<AccessPayload>(p);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(opts.aud)) throw new AccessJwtError("audience mismatch");
  if (payload.iss !== issuer) throw new AccessJwtError("issuer mismatch");
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_SECONDS < nowSec) throw new AccessJwtError("token expired");
  if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_SECONDS > nowSec) throw new AccessJwtError("token not yet valid");
  return payload;
}
