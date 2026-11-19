// Unit tests (no browser): the Cloudflare Access seam, CSV cells, the audit hash chain.
import { expect, test } from "@playwright/test";
import { verifyAccessJwt, type AccessJwk } from "../../src/access-jwt";
import { extendChain, verifyChain } from "../../src/audit";
import { csvCell, toCsv } from "../../src/csv";
import { HttpError } from "../../src/http";
import { resolveIdentity, roleFromMap } from "../../src/identity";

const TEAM = "https://acme.cloudflareaccess.com";
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

let keys: CryptoKeyPair;
let jwks: AccessJwk[];

test.beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  jwks = [{ ...jwk, kid: "key-1" } as AccessJwk];
});

async function token(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "key-1", typ: "JWT" }) {
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: TEAM,
  email: "ana@shop.example",
  iat: NOW / 1000 - 60,
  nbf: NOW / 1000 - 60,
  exp: NOW / 1000 + 3600,
  ...over,
});
const opts = { teamDomain: TEAM, aud: AUD, now: NOW, fetchJwks: async () => jwks };

test.describe("Access JWT verification", () => {
  test("accepts a valid token and returns its claims", async () => {
    const payload = await verifyAccessJwt(await token(claims()), opts);
    expect(payload.email).toBe("ana@shop.example");
  });

  test("accepts the team domain without a scheme or with a trailing slash", async () => {
    await expect(verifyAccessJwt(await token(claims()), { ...opts, teamDomain: "acme.cloudflareaccess.com/" })).resolves.toBeTruthy();
  });

  const bad: Array<[string, () => Promise<string>, string]> = [
    ["wrong audience", () => token(claims({ aud: ["someone-else"] })), "audience mismatch"],
    ["wrong issuer", () => token(claims({ iss: "https://evil.cloudflareaccess.com" })), "issuer mismatch"],
    ["expired", () => token(claims({ exp: NOW / 1000 - 3600 })), "token expired"],
    ["not yet valid", () => token(claims({ nbf: NOW / 1000 + 3600 })), "token not yet valid"],
    ["alg none", () => token(claims(), { alg: "none", kid: "key-1" }), "unexpected algorithm"],
    ["HS256", () => token(claims(), { alg: "HS256", kid: "key-1" }), "unexpected algorithm"],
    ["unknown key", () => token(claims(), { alg: "RS256", kid: "key-2" }), "unknown signing key"],
    [
      "tampered payload",
      async () => {
        const [h, , s] = (await token(claims())).split(".");
        return `${h}.${enc(claims({ email: "boss@shop.example" }))}.${s}`;
      },
      "bad signature",
    ],
    ["garbage", async () => "not.a.jwt!", "malformed token"],
  ];
  for (const [name, make, reason] of bad) {
    test(`rejects: ${name}`, async () => {
      await expect(verifyAccessJwt(await make(), opts)).rejects.toThrow(reason);
    });
  }
});

test.describe("resolveIdentity: the one place roles come from", () => {
  const prod = {
    DEMO_MODE: "false",
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ROLE_MAP: JSON.stringify({ "ana@shop.example": "owner", "*@shop.example": "staff", "lee@shop.example": "manager" }),
  };
  const req = (headers: Record<string, string>) => new Request("https://desk.shop.example/api/session", { headers });
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (err) {
      return err instanceof HttpError ? `${err.status} ${err.code}` : String(err);
    }
  };

  test("production: role comes from ROLE_MAP for the verified Access email", async () => {
    const who = await resolveIdentity(req({ "cf-access-jwt-assertion": await token(claims()) }), prod, { fetchJwks: opts.fetchJwks, now: NOW });
    expect(who).toEqual({ role: "owner", actor: "ana@shop.example", source: "access", email: "ana@shop.example" });
    const staff = await resolveIdentity(req({ "cf-access-jwt-assertion": await token(claims({ email: "Kim@Shop.Example" })) }), prod, { fetchJwks: opts.fetchJwks, now: NOW });
    expect(staff.role).toBe("staff");
  });

  test("production: no header, bad token, unmapped email, missing config", async () => {
    expect(await status(resolveIdentity(req({}), prod))).toBe("401 access_required");
    expect(await status(resolveIdentity(req({ "cf-access-jwt-assertion": "x.y.z" }), prod, { fetchJwks: opts.fetchJwks, now: NOW }))).toBe("403 access_denied");
    const stranger = await token(claims({ email: "eve@elsewhere.example" }));
    expect(await status(resolveIdentity(req({ "cf-access-jwt-assertion": stranger }), prod, { fetchJwks: opts.fetchJwks, now: NOW }))).toBe("403 no_role");
    expect(await status(resolveIdentity(req({ cookie: "od_role=owner" }), { ...prod, ACCESS_AUD: "" }))).toBe("500 access_not_configured");
    // A demo cookie never grants anything in production.
    expect(await status(resolveIdentity(req({ cookie: "od_role=owner" }), prod))).toBe("401 access_required");
  });

  test("demo: role comes from the switcher cookie, defaulting to staff", async () => {
    const demo = { DEMO_MODE: "true", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", ROLE_MAP: "{}" };
    expect((await resolveIdentity(req({ cookie: "od_sbx=abc; od_role=manager" }), demo)).role).toBe("manager");
    expect((await resolveIdentity(req({ cookie: "od_role=admin" }), demo)).role).toBe("staff");
    expect((await resolveIdentity(req({}), demo)).actor).toBe("Sam");
    // Without Access configured, a stray header is ignored and the cookie decides.
    expect((await resolveIdentity(req({ cookie: "od_role=owner", "cf-access-jwt-assertion": "x.y.z" }), demo)).role).toBe("owner");
  });

  test("ROLE_MAP: exact email beats the domain wildcard; bad JSON grants nothing", () => {
    expect(roleFromMap(prod.ROLE_MAP, "lee@shop.example")).toBe("manager");
    expect(roleFromMap(prod.ROLE_MAP, "new@shop.example")).toBe("staff");
    expect(roleFromMap(prod.ROLE_MAP, "x@other.example")).toBeNull();
    expect(roleFromMap('{"a@b.c": "admin"}', "a@b.c")).toBeNull();
    expect(roleFromMap("{not json", "a@b.c")).toBeNull();
  });
});

test.describe("CSV cells", () => {
  test("neutralises formulas and quotes special characters", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+31 6")).toBe("'+31 6");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("﻿a,b\r\n1,x\r\n");
  });
});

test.describe("audit hash chain", () => {
  test("verifies an untouched chain and pinpoints a tampered entry", async () => {
    const entries = await extendChain(null, [
      { at: 1, actor: "Sam", role: "staff", action: "request.created", ref: 101, detail: "Filed" },
      { at: 2, actor: "Alex", role: "manager", action: "request.approved", ref: 101, detail: "Approved" },
      { at: 3, actor: "Sam", role: "staff", action: "request.completed", ref: 101, detail: "Done" },
    ]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[0].prev_hash).toBe("GENESIS");
    expect(entries[1].prev_hash).toBe(entries[0].hash);
    expect(await verifyChain(entries)).toMatchObject({ ok: true, count: 3, head: entries[2].hash });

    const tampered = entries.map((e) => ({ ...e }));
    tampered[1].detail = "Approved (edited later)";
    expect(await verifyChain(tampered)).toMatchObject({ ok: false, brokenAt: 2 });
    expect(await verifyChain([entries[0], entries[2]])).toMatchObject({ ok: false, brokenAt: 3 });
  });
});
