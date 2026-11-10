import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import worker from "./worker.mjs";
import { inviteSessionEmail } from "./boarder-sign-in.mjs";
import { accessEmail, mutationEnvelope, privateHeaders, rateLimit, secureHtml } from "./security.mjs";

const origin = "https://security.example.invalid";
const email = "fictional.boarder@reptondubai.net";
function inviteEnvironment() {
  const code = randomBytes(24).toString("base64url");
  return { code, env: {
    JARVIS_BOARDER_LINKS: JSON.stringify({ [email]: "fictional-a" }),
    JARVIS_INVITE_HASHES: JSON.stringify({ [email]: createHash("sha256").update(code).digest("hex") }),
    JARVIS_SESSION_SECRET: randomBytes(32).toString("hex")
  } };
}
const login = (env, code, extra = {}, loginName = email) => worker.fetch(new Request(origin + "/sign-in", {
  method: "POST", headers: { Origin: origin, ...extra },
  body: new URLSearchParams({ email: loginName, code })
}), env, {});

test("sign-in limits attempts per source and canonical account, with retry guidance", async () => {
  const { env, code } = inviteEnvironment();
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal((await login(env, "x".repeat(32))).status, 401);
  }
  const blocked = await login(env, code);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("Retry-After"), "60");
  assert.equal(blocked.headers.get("Cache-Control"), "private, no-store");
  assert.equal(blocked.headers.get("Set-Cookie"), null);

  const other = inviteEnvironment();
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt % 2 ? "FICTIONAL.BOARDER" : email;
    assert.equal((await login(other.env, "x".repeat(32), { "CF-Connecting-IP": "192.0.2." + attempt }, name)).status, 401);
  }
  assert.equal((await login(other.env, other.code, { "CF-Connecting-IP": "192.0.2.99" }, "fictional.boarder")).status, 429);
});

test("rate windows reset and configured rate bindings fail closed without exposing identifiers", async () => {
  const env = {};
  for (let i = 0; i < 20; i++) assert.equal((await rateLimit(env, "auth-ip", "synthetic", 1000)).allowed, true);
  assert.equal((await rateLimit(env, "auth-ip", "synthetic", 1000)).allowed, false);
  assert.equal((await rateLimit(env, "auth-ip", "synthetic", 61000)).allowed, true);
  let key;
  const configured = { JARVIS_WRITE_LIMITER: { limit: async value => { key = value.key; return { success: false }; } } };
  assert.equal((await rateLimit(configured, "planner-write", "fictional-student-id")).allowed, false);
  assert.doesNotMatch(key, /fictional/);
  configured.JARVIS_WRITE_LIMITER.limit = async () => { throw new Error("Unavailable"); };
  assert.equal((await rateLimit(configured, "planner-write", "fictional-student-id")).unavailable, true);
  assert.equal((await rateLimit({ JARVIS_REQUIRE_RATE_LIMITS: "true" }, "auth-ip", "synthetic")).unavailable, true);
});

test("mutations reject cross-site, missing origin, compression, oversized and ambiguous sign-in requests", async () => {
  const { env, code } = inviteEnvironment();
  assert.equal((await login(env, code, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await login(env, code, { "Sec-Fetch-Site": "same-site" })).status, 403);
  assert.equal((await login(env, code, { "Content-Encoding": "gzip" })).status, 415);
  assert.equal((await login(env, code, { "Content-Length": "1025" })).status, 413);
  const duplicate = await worker.fetch(new Request(origin + "/sign-in", {
    method: "POST", headers: { Origin: origin },
    body: new URLSearchParams([["email", email], ["email", "other@reptondubai.net"], ["code", code]])
  }), env, {});
  assert.equal(duplicate.status, 401);
  const tooLarge = await worker.fetch(new Request(origin + "/sign-in", {
    method: "POST", headers: { Origin: origin },
    body: new URLSearchParams({ email, code, padding: "x".repeat(1100) })
  }), env, {});
  assert.equal(tooLarge.status, 401);
  assert.equal(mutationEnvelope(new Request(origin, { method: "POST" }), 4096).status, 403);
  assert.equal((await worker.fetch(new Request(origin + "/sign-out", {
    method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "cross-site" }
  }), env, {})).status, 403);
});

test("invite cookies expire and link removal revokes access before any school reads", async t => {
  const { env, code } = inviteEnvironment();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2027-01-01T12:00:00Z") });
  const signedIn = await login(env, code);
  assert.equal(signedIn.status, 303);
  const cookie = signedIn.headers.get("Set-Cookie").split(";")[0];
  const request = new Request(origin, { headers: { Cookie: cookie } });
  assert.equal(await inviteSessionEmail(request, env), email);
  const originalLinks = env.JARVIS_BOARDER_LINKS;
  env.JARVIS_BOARDER_LINKS = "{}";
  assert.equal(await inviteSessionEmail(request, env), "");
  env.JARVIS_BOARDER_LINKS = originalLinks;
  t.mock.timers.tick(8 * 60 * 60 * 1000);
  assert.equal(await inviteSessionEmail(request, env), "");
});

test("HTML policy nonces executable scripts, retains inert profile JSON and denies framing and remote script access", async () => {
  const html = '<script id="jarvis-fry-house-record" type="application/json">{"name":"Fictional"}</script><script>window.ready=true</script>';
  const a = secureHtml(html), b = secureHtml(html);
  const body = await a.text();
  const nonce = body.match(/<script nonce="([a-f0-9]+)">/)[1];
  assert.match(body, /<script id="jarvis-fry-house-record" type="application\/json">/);
  assert.match(a.headers.get("Content-Security-Policy"), new RegExp("script-src 'nonce-" + nonce + "'"));
  assert.notEqual(a.headers.get("Content-Security-Policy"), b.headers.get("Content-Security-Policy"));
  assert.match(a.headers.get("Content-Security-Policy"), /script-src-attr 'none'/);
  assert.match(a.headers.get("Content-Security-Policy"), /connect-src 'self'/);
  assert.doesNotMatch(a.headers.get("Content-Security-Policy"), /unsafe-eval|script-src 'unsafe-inline'/);
  assert.equal(a.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  assert.match(a.headers.get("Permissions-Policy"), /microphone=\(\)/);
});

test("Access JWT fallback verifies signature, issuer, audience and validity; spoofed identity headers are inert", async t => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = "https://fictional-security-test.cloudflareaccess.com";
  const audience = "fictional-app-audience";
  const env = { JARVIS_ACCESS_AUDIENCE: audience, JARVIS_ACCESS_TEAM_DOMAIN: issuer };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuer, aud: [audience], email, iat: now - 10, exp: now + 300, nbf: now - 10 };
  const makeJwt = (claims = {}, header = {}) => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = encode({ alg: "RS256", kid: "fictional-key", ...header }) + "." + encode({ ...payload, ...claims });
    return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  };
  const check = (token, customEnv = env) => accessEmail(new Request(origin, {
    headers: { "Cf-Access-Jwt-Assertion": token, "Cf-Access-Authenticated-User-Email": "spoof@example.invalid" }
  }), customEnv, {});
  const fetch = t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.equal(input, issuer + "/cdn-cgi/access/certs");
    assert.equal(options.redirect, "error");
    return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fictional-key", alg: "RS256", use: "sig" }] });
  });
  assert.equal(await check(makeJwt()), email);
  assert.equal(await check(makeJwt()), email);
  assert.equal(fetch.mock.callCount(), 1);
  for (const bad of [
    makeJwt({ iss: "https://attacker.example.invalid" }), makeJwt({ aud: ["wrong"] }),
    makeJwt({ exp: now - 1 }), makeJwt({ nbf: now + 500 }), makeJwt({ iat: now + 500 }),
    makeJwt({ email: "" }), makeJwt({}, { alg: "HS256" }), makeJwt({}, { kid: "unknown" })
  ]) assert.equal(await check(bad), "");
  const [head, claims, signature] = makeJwt().split(".");
  assert.equal(await check(head + "." + claims + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1)), "");
  assert.equal(await check(makeJwt(), { ...env, JARVIS_ACCESS_TEAM_DOMAIN: "https://attacker.example.invalid" }), "");
  assert.equal(await accessEmail(new Request(origin, { headers: { "Cf-Access-Authenticated-User-Email": email } }), env, {}), "");
  assert.equal(await accessEmail(new Request(origin), env, { access: { aud: audience, getIdentity: async () => ({ email }) } }), email);
  assert.equal(await accessEmail(new Request(origin), env, { access: { aud: "wrong", getIdentity: async () => ({ email }) } }), "");
});

test("authenticated planner writes are limited by server-derived boarder and all routes enforce security headers", async () => {
  let seen;
  const env = {
    JARVIS_ACCESS_AUDIENCE: "limits-test", JARVIS_BOARDER_LINKS: '{"a@example.invalid":"fictional-a"}',
    JARVIS_WRITE_LIMITER: { limit: async ({ key }) => { seen = key; return { success: false }; } }
  };
  const ctx = { access: { aud: "limits-test", getIdentity: async () => ({ email: "a@example.invalid" }) } };
  for (const path of ["personal-calendar", "boarder-progress", "boarder-goals"]) {
    const response = await worker.fetch(new Request(origin + "/api/" + path + "?studentId=b", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: '{"studentId":"b"}'
    }), env, ctx);
    assert.equal(response.status, 429);
    assert.match(seen, /^planner-write:[a-f0-9]{64}$/);
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    const crossSite = await worker.fetch(new Request(origin + "/api/" + path, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: "{}"
    }), env, ctx);
    assert.equal(crossSite.status, 403);
  }
  const notFound = await worker.fetch(new Request(origin + "/missing"), env, {});
  for (const [name, value] of Object.entries(privateHeaders)) assert.equal(notFound.headers.get(name), value);
});
