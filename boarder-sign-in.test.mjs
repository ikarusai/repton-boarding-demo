import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import worker from "./worker.mjs";

test("school access codes issue a private, revocable boarder session", async () => {
  const origin = "https://jarvis.example.invalid";
  const email = "pilot.boarder@reptondubai.net";
  const code = randomBytes(24).toString("base64url");
  const digest = value => createHash("sha256").update(value).digest("hex");
  const env = {
    JARVIS_BOARDER_LINKS: JSON.stringify({ [email]: "sample-a" }),
    JARVIS_INVITE_HASHES: JSON.stringify({ [email]: digest(code) }),
    JARVIS_SESSION_SECRET: randomBytes(32).toString("hex"),
    JARVIS_STAFF_EMAILS: JSON.stringify([email])
  };
  function visit(path, headers) {
    return worker.fetch(new Request(origin + path, { headers }), env, {});
  }
  function signIn(address, accessCode, requestOrigin = origin) {
    return worker.fetch(new Request(origin + "/sign-in", { method: "POST",
      headers: { Origin: requestOrigin },
      body: new URLSearchParams({ email: address, code: accessCode })
    }), env, {});
  }

  const landing = await visit("/");
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get("Referrer-Policy"), "same-origin");
  const landingHtml = await landing.text();
  assert.match(landingHtml, /School username.*firstname\.surname.*Access code/s);
  assert.match(landingHtml, /Dates to know\./);
  assert.doesNotMatch(landingHtml, /jarvis-fry-house-record|My Fry House record|<strong\s+data-home-sanctions\b/);
  const directSignIn = await visit("/sign-in");
  assert.equal(directSignIn.status, 302);
  assert.equal(directSignIn.headers.get("Location"), "/");
  assert.equal((await visit("/api/boarder-progress")).status, 403);
  assert.equal((await signIn(email, "pilot.boarder")).status, 401);
  assert.equal((await signIn("pilot.boarder", "pilot.boarder")).status, 401);
  assert.equal((await signIn("other", code)).status, 401);
  assert.equal((await signIn("other@reptondubai.net", code)).status, 401);
  assert.equal((await signIn(email, code, "https://unrelated.example.invalid")).status, 403);
  assert.equal((await signIn("PILOT.BOARDER", code)).status, 303);
  env.JARVIS_BOARDER_LINKS = JSON.stringify({ [email]: "sample-a", "pilot.boarder@reptondubai.org": "sample-b" });
  assert.equal((await signIn("pilot.boarder", code)).status, 401);

  const accepted = await signIn(email.toUpperCase(), code);
  assert.equal(accepted.status, 303);
  const cookie = accepted.headers.get("Set-Cookie");
  assert.match(cookie, /; Secure; HttpOnly; SameSite=Strict;/);
  const session = cookie.split(";")[0];
  const requestHeaders = { Cookie: session };
  const progress = await visit("/api/boarder-progress", requestHeaders);
  assert.equal(progress.status, 503);
  assert.match(await progress.text(), /Progress saving is awaiting school setup/);
  assert.equal((await visit("/staff/sanctions", requestHeaders)).status, 403);

  const [payload, signature] = session.split(".");
  const tampered = payload + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  assert.equal((await visit("/api/boarder-progress", { Cookie: tampered })).status, 403);

  const signOut = await worker.fetch(new Request(origin + "/sign-out", {
    method: "POST", headers: { ...requestHeaders, Origin: origin }
  }), env, {});
  assert.equal(signOut.status, 303);
  assert.match(signOut.headers.get("Set-Cookie"), /^__Host-jarvis-session=;.*Max-Age=0$/);

  env.JARVIS_INVITE_HASHES = JSON.stringify({ [email]: digest(randomBytes(24).toString("base64url")) });
  assert.equal((await visit("/api/boarder-progress", requestHeaders)).status, 403);
});
