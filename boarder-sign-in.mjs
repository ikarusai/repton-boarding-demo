import { boarderIdForEmail } from "./performance.mjs";
import { publicCommandCentre as signInPage } from "./command-centre.mjs";
import { mutationEnvelope, rateLimit, rateLimitResponse } from "./security.mjs";

export { signInPage };

const cookieName = "__Host-jarvis-session";
const lifetime = 8 * 60 * 60;
const cookieOptions = "Path=/; Secure; HttpOnly; SameSite=Strict";
const encoder = new TextEncoder();
const schoolEmail = /^[a-z0-9._+-]+@reptondubai\.(?:net|org)$/;
const randomCode = /^[A-Za-z0-9_-]{32,64}$/;
const hex = /^[a-f0-9]{64}$/;
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));

export function inviteSignInEnabled(env) {
  return Boolean(env.JARVIS_BOARDER_LINKS && env.JARVIS_INVITE_HASHES && hex.test(env.JARVIS_SESSION_SECRET || ""));
}

function inviteHash(env, email) {
  if (!schoolEmail.test(email) || !boarderIdForEmail(env.JARVIS_BOARDER_LINKS, email)) return "";
  const invites = JSON.parse(env.JARVIS_INVITE_HASHES);
  const hash = Object.hasOwn(invites, email) ? invites[email] : "";
  return typeof hash === "string" && hex.test(hash) ? hash : "";
}

function emailForLogin(login, mapping) {
  if (login.includes("@")) return login;
  if (!login) return "";
  const matches = Object.keys(JSON.parse(mapping))
    .map(email => email.trim().toLowerCase())
    .filter(email => schoolEmail.test(email) && email.split("@")[0] === login);
  return matches.length === 1 ? matches[0] : "";
}

async function signingKey(env) {
  const bytes = Uint8Array.from(env.JARVIS_SESSION_SECRET.match(/../g), pair => parseInt(pair, 16));
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signInFields(request) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0, body = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      const fields = new URLSearchParams(body + decoder.decode());
      return fields.getAll("email").length === 1 && fields.getAll("code").length === 1 ? fields : null;
    }
    bytes += value.byteLength;
    if (bytes > 1024) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
}

export async function inviteSessionEmail(request, env) {
  if (!inviteSignInEnabled(env)) return "";
  const cookie = request.headers.get("Cookie")?.match(/(?:^|;\s*)__Host-jarvis-session=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:;|$)/)?.[1];
  if (!cookie || cookie.length > 700) return "";
  try {
    const [payload, signature] = cookie.split(".");
    const { email, expires } = JSON.parse(new TextDecoder().decode(decode(payload)));
    const now = Math.floor(Date.now() / 1000);
    if (typeof email !== "string" || !Number.isSafeInteger(expires) || expires <= now || expires > now + lifetime) return "";
    const hash = inviteHash(env, email);
    if (!hash) return "";
    return await crypto.subtle.verify("HMAC", await signingKey(env), decode(signature), encoder.encode(payload + "." + hash))
      ? email : "";
  } catch {
    return "";
  }
}

export async function submitInviteSignIn(request, env, headers) {
  const invalidEnvelope = mutationEnvelope(request, 1024);
  if (invalidEnvelope) return new Response(invalidEnvelope.error, { status: invalidEnvelope.status, headers });
  if (new URL(request.url).pathname === "/sign-out") {
    return new Response(null, { status: 303, headers: { ...headers, Location: "/",
      "Set-Cookie": cookieName + "=; " + cookieOptions + "; Max-Age=0" } });
  }
  if (!inviteSignInEnabled(env)) return signInPage(headers, false, 503);
  const origin = new URL(request.url).origin;
  const ipLimit = await rateLimit(env, "auth-ip", origin + ":" + (request.headers.get("CF-Connecting-IP") || "local"));
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit, headers);
  const fields = await signInFields(request);
  const login = (fields?.get("email") || "").trim().toLowerCase();
  const code = (fields?.get("code") || "").trim();
  const invalid = () => signInPage(headers, true, 401, true);
  if (!randomCode.test(code) || login.length > 150) return invalid();
  const email = emailForLogin(login, env.JARVIS_BOARDER_LINKS);
  const accountLimit = await rateLimit(env, "auth-account", origin + ":" + (email || login));
  if (!accountLimit.allowed) return rateLimitResponse(accountLimit, headers);
  const hash = inviteHash(env, email);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code)));
  const expected = hash || "0".repeat(64);
  let mismatch = 0;
  digest.forEach((byte, index) => { mismatch |= byte ^ parseInt(expected.slice(index * 2, index * 2 + 2), 16); });
  if (!hash || mismatch) return invalid();
  const payload = encode(encoder.encode(JSON.stringify({ email, expires: Math.floor(Date.now() / 1000) + lifetime })));
  const signature = encode(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(payload + "." + hash))));
  return new Response(null, { status: 303, headers: { ...headers, Location: "/",
    "Set-Cookie": cookieName + "=" + payload + "." + signature + "; " + cookieOptions + "; Max-Age=" + lifetime } });
}
