// Server-side guards shared by the Worker and invite flow. No student data is logged.
export const privateHeaders = Object.freeze({
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000"
});

export function sameOriginMutation(request) {
  const site = request.headers.get("Sec-Fetch-Site");
  return request.headers.get("Origin") === new URL(request.url).origin &&
    (!site || site === "same-origin" || site === "none");
}

export function mutationEnvelope(request, maxBytes) {
  if (!sameOriginMutation(request)) return { status: 403, error: "Open Jarvis to save this change." };
  const encoding = request.headers.get("Content-Encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    return { status: 415, error: "Compressed requests are not supported." };
  }
  const length = request.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    return { status: 413, error: "This request is too large." };
  }
  return null;
}

export function secureHtml(html, headers = privateHeaders, status = 200) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  // The template has no script text containing opening script tags. JSON data
  // blocks remain inert and retain their exact tag contract for the client.
  const body = html.replace(/<script\b([^>]*)>/gi, (tag, attributes) => {
    if (/\btype\s*=\s*["']application\/json["']/i.test(attributes)) return tag;
    return '<script nonce="' + nonce + '"' + attributes.replace(/\snonce\s*=\s*["'][^"']*["']/gi, "") + ">";
  });
  return new Response(body, { status, headers: { ...headers,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce +
      "'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
      "font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'"
  } });
}

// This bounded fallback is per isolate, and resets when the isolate is evicted.
// Cloudflare bindings, when configured, provide approximate per-location limits.
// Neither is a global lockout or an exact distributed security quota.
const bucketsByEnvironment = new WeakMap();
const encoder = new TextEncoder();
export async function rateLimit(env, scope, subject, now = Date.now()) {
  const auth = scope.startsWith("auth-");
  const limit = auth ? 20 : 60;
  const windowMs = 60_000;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(scope + ":" + subject)));
  const key = scope + ":" + Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const binding = auth ? env.JARVIS_AUTH_LIMITER : env.JARVIS_WRITE_LIMITER;
  if (!binding && env.JARVIS_REQUIRE_RATE_LIMITS === "true") {
    return { allowed: false, unavailable: true, retryAfter: 60 };
  }
  if (binding) {
    try {
      const result = await binding.limit({ key });
      return result?.success === true ? { allowed: true } : { allowed: false, retryAfter: 60 };
    } catch {
      // Never silently downgrade a configured security service on failure.
      return { allowed: false, unavailable: true, retryAfter: 60 };
    }
  }
  let buckets = bucketsByEnvironment.get(env);
  if (!buckets) bucketsByEnvironment.set(env, buckets = new Map());
  for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
  let bucket = buckets.get(key);
  if (!bucket) {
    // Do not evict active limits under high-cardinality attacks.
    if (buckets.size >= 4096) return { allowed: false, retryAfter: 60 };
    buckets.set(key, bucket = { count: 0, until: now + windowMs });
  }
  bucket.count += 1;
  return bucket.count <= limit ? { allowed: true } :
    { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.until - now) / 1000)) };
}

export function rateLimitResponse(result, headers = privateHeaders) {
  return Response.json({ error: result.unavailable
    ? "Security checks are temporarily unavailable. Try again shortly."
    : "Too many attempts. Wait a minute and try again." }, {
    status: result.unavailable ? 503 : 429,
    headers: { ...headers, "Retry-After": String(result.retryAfter || 60) }
  });
}

const jwksCache = new Map();
const decode = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
function teamIssuer(value) {
  if (typeof value !== "string" || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com\/?$/.test(value)) return "";
  return value.replace(/\/$/, "");
}

async function accessKeys(issuer, now) {
  let cached = jwksCache.get(issuer);
  if (cached && cached.expires > now) return cached.keys;
  const response = await fetch(issuer + "/cdn-cgi/access/certs", {
    redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error("Access keys unavailable");
  // Bound a remote response before parsing, including responses without length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Access keys unavailable");
  let size = 0, body = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new Error("Access keys too large"); }
    body += decoder.decode(value, { stream: true });
  }
  const { keys } = JSON.parse(body + decoder.decode());
  if (!Array.isArray(keys) || !keys.length || keys.length > 20) throw new Error("Invalid Access keys");
  if (jwksCache.size >= 8) jwksCache.delete(jwksCache.keys().next().value);
  jwksCache.set(issuer, { keys, expires: now + 60_000 });
  return keys;
}

export async function accessEmail(request, env, ctx = {}) {
  const audience = env.JARVIS_ACCESS_AUDIENCE;
  if (typeof audience !== "string" || !audience) return "";
  // ctx.access is supplied by Cloudflare after authentication for direct Worker
  // invocations. Request headers cannot create this context.
  if (ctx.access) {
    if (ctx.access.aud !== audience) return "";
    if (typeof ctx.access.getIdentity === "function") {
      const identity = await ctx.access.getIdentity();
      if (typeof identity?.email === "string" && identity.email.trim()) return identity.email.trim().toLowerCase();
    }
  }
  const issuer = teamIssuer(env.JARVIS_ACCESS_TEAM_DOMAIN);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!issuer || !token || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return "";
  try {
    const [head, data, signature] = token.split(".");
    const parse = part => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(part)));
    const header = parse(head), payload = parse(data);
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256 || header.crit ||
        payload.iss !== issuer || !Array.isArray(payload.aud) || !payload.aud.includes(audience) ||
        !Number.isSafeInteger(payload.exp) || payload.exp <= now ||
        !Number.isSafeInteger(payload.iat) || payload.iat > now + 30 || payload.iat >= payload.exp ||
        (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > now + 30)) ||
        typeof payload.email !== "string" || payload.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(payload.email)) return "";
    const keys = await accessKeys(issuer, Date.now());
    const matching = keys.filter(key => key.kid === header.kid && key.kty === "RSA" && key.alg === "RS256" && key.use === "sig");
    if (matching.length !== 1) return "";
    const key = await crypto.subtle.importKey("jwk", matching[0], { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(signature), encoder.encode(head + "." + data))) return "";
    return payload.email.trim().toLowerCase();
  } catch {
    return "";
  }
}
