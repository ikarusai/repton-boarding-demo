import page from "./page.generated.mjs";
import { boarderIdForEmail, projectHouseTerms, readFryHouseProfile } from "./performance.mjs";
import { servePersonalCalendar } from "./personal-calendar.mjs";
import { serveBoarderProgress } from "./boarder-progress.mjs";
import { serveBoarderGoals } from "./boarder-goals.mjs";
import { readRanges, rosterSpreadsheetId, sheetsToken } from "./google-sheets.mjs";
import { readApprovedPhoto } from "./recognition.mjs";
import { inviteSessionEmail, inviteSignInEnabled, signInPage, submitInviteSignIn } from "./boarder-sign-in.mjs";
import { accessEmail, mutationEnvelope, privateHeaders, rateLimit, rateLimitResponse, secureHtml } from "./security.mjs";

function message(text, status) {
  return new Response(text, { status, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}

function staffAllowed(mapping, email) {
  const allowed = mapping ? JSON.parse(mapping) : [];
  return Array.isArray(allowed) && allowed.some(value => typeof value === "string" &&
    value.trim().toLowerCase() === email.trim().toLowerCase());
}

function helpContacts(value) {
  let config;
  try {
    config = value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
  const contacts = {};
  for (const role of ["duty", "backup"]) {
    const contact = config?.[role];
    const instructions = typeof contact?.instructions === "string" ? contact.instructions.trim() : "";
    if (!instructions || instructions.length > 250) continue;
    contacts[role] = { instructions };
    if (typeof contact.phone === "string" && /^\+[1-9]\d{6,14}$/.test(contact.phone)) {
      contacts[role].phone = contact.phone;
    }
  }
  return contacts;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function staffSanctions(env) {
  const token = await sheetsToken(env.FRY_HOUSE_SHEETS_CLIENT_EMAIL, env.FRY_HOUSE_SHEETS_PRIVATE_KEY);
  const records = projectHouseTerms(await readRanges(token, rosterSpreadsheetId, [
    "'Boarder Performance'!A1:E", "'Behaviour Events'!A1:F"
  ]));
  const period = records.map(row => row.period).sort((a, b) => b.end.localeCompare(a.end) || b.start.localeCompare(a.start))[0];
  const rows = records.filter(row => row.period.start === period?.start && row.period.end === period?.end && row.sanctions.length)
    .sort((a, b) => b.sanctions.length - a.sanctions.length || a.name.localeCompare(b.name));
  const body = rows.map(row => "<tr><th scope=\"row\">" + escapeHtml(row.name) + "</th><td>" + row.year +
    "</td>" + ["B1", "B2", "B3", "B4"].map(level =>
      "<td>" + row.sanctions.filter(([, code]) => code === level).length + "</td>").join("") +
    "<td>" + row.sanctions.length + "</td></tr>").join("");
  return secureHtml(`<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Fry House · Staff sanctions</title>
    <style>
      body { color: #f8f1dc; background: #0d1727; font: 16px/1.5 system-ui; margin: 0; }
      main { max-width: 960px; margin: auto; padding: 32px 20px; }
      h1 { margin: .3em 0; } p { color: #c7cdd7; }
      .scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: .7em; border-bottom: 1px solid #495160; }
      thead { color: #f4d48b; background: #222e42; }
      h1, table :is(th, td):nth-child(n+3) { color: #fda4af; }
      tbody td:last-child { font-weight: 700; background: #fda4af12; }
    </style>
    <main><p>REPTON DUBAI · FRY HOUSE · STAFF</p><h1>Sanctions by boarder</h1>
    <p>${period ? escapeHtml(period.start + " to " + period.end) : "Term records unavailable"}</p>
    ${body ? '<div class="scroll"><table><thead><tr><th scope="col">Boarder</th><th scope="col">Year</th><th scope="col">B1</th><th scope="col">B2</th><th scope="col">B3</th><th scope="col">B4</th><th scope="col">Total</th></tr></thead><tbody>' + body + '</tbody></table></div>' : '<p>No sanctions to list for this term.</p>'}</main></html>`,
    privateHeaders);
}

export default {
  async fetch(request, env, ctx = {}) {
    const path = new URL(request.url).pathname;
    if (path === "/sign-in" || path === "/sign-out") {
      if (path === "/sign-in" && request.method === "GET") {
        return new Response(null, { status: 302, headers: { ...privateHeaders, Location: "/" } });
      }
      if (request.method !== "POST") return message("Method not allowed.", 405);
      try {
        return await submitInviteSignIn(request, env, privateHeaders);
      } catch {
        return message("Jarvis sign-in is temporarily unavailable.", 503);
      }
    }
    const planner = path === "/api/personal-calendar";
    const progress = path === "/api/boarder-progress";
    const goals = path === "/api/boarder-goals";
    const sanctions = path === "/staff/sanctions";
    const photo = /^\/house\/photo\/([A-Za-z0-9_-]{15,100})$/.exec(path);
    if (path !== "/" && !planner && !progress && !goals && !sanctions && !photo) return message("Page not found.", 404);
    if (request.method !== "GET" && !((planner || progress || goals) && request.method === "POST")) return message("Method not allowed.", 405);
    if (request.method === "POST") {
      const invalid = mutationEnvelope(request, goals ? 16384 : progress ? 8192 : 4096);
      if (invalid) return Response.json({ error: invalid.error }, { status: invalid.status, headers: privateHeaders });
    }
    let access = false;
    const invites = inviteSignInEnabled(env);
    if (!env.JARVIS_BOARDER_LINKS || (!env.JARVIS_ACCESS_AUDIENCE && !invites)) {
      return path === "/" ? signInPage(privateHeaders, false) : message("Jarvis sign-in setup is pending.", 503);
    }
    let studentId;
    try {
      const verifiedAccessEmail = await accessEmail(request, env, ctx);
      access = Boolean(verifiedAccessEmail);
      const email = verifiedAccessEmail || (sanctions ? "" : await inviteSessionEmail(request, env));
      if (typeof email !== "string" || !email.trim()) {
        return path === "/" && invites ? signInPage(privateHeaders, true) : message("School sign-in is required.", 403);
      }
      if (sanctions) {
        if (!staffAllowed(env.JARVIS_STAFF_EMAILS, email)) return message("Staff sign-in is required.", 403);
        return await staffSanctions(env).catch(() => message("The staff sanctions report is temporarily unavailable.", 503));
      }
      studentId = boarderIdForEmail(env.JARVIS_BOARDER_LINKS, email);
    } catch {
      return message("Jarvis could not verify the school account link.", 503);
    }
    if (!studentId) return message("This school account has no Fry House profile linked. Ask your house tutor.", 403);
    if (request.method === "POST") {
      const allowance = await rateLimit(env, "planner-write", new URL(request.url).origin + ":" + studentId);
      if (!allowance.allowed) return rateLimitResponse(allowance);
    }
    if (photo) {
      try {
        return await readApprovedPhoto(photo[1], env, privateHeaders) || message("Photo not available.", 404);
      } catch {
        return message("Photo not available.", 404);
      }
    }
    if (planner) {
      try {
        return await servePersonalCalendar(request, env, studentId, privateHeaders);
      } catch {
        return Response.json({ error: "Calendar saving is temporarily unavailable. Try again." },
          { status: 503, headers: privateHeaders });
      }
    }
    if (progress) {
      try {
        return await serveBoarderProgress(request, env, studentId, privateHeaders);
      } catch {
        return Response.json({ error: "Progress saving is temporarily unavailable. Try again." },
          { status: 503, headers: privateHeaders });
      }
    }
    if (goals) {
      try {
        return await serveBoarderGoals(request, env, studentId, privateHeaders);
      } catch {
        return Response.json({ error: "Goal saving is temporarily unavailable. Try again." },
          { status: 503, headers: privateHeaders });
      }
    }
    try {
      const profile = await readFryHouseProfile(studentId, env);
      if (!profile) return message("The linked Fry House profile is unavailable. Ask your house tutor.", 404);
      profile.helpContacts = helpContacts(env.JARVIS_HELP_CONTACTS);
      const json = JSON.stringify(profile).replace(/</g, "\\u003c");
      let html = page.replace("<!-- JARVIS_PROFILE -->", () => '<script id="jarvis-fry-house-record" type="application/json">' + json + '</script>');
      if (!access) html = html.replace("<!-- JARVIS_SIGN_OUT -->",
        '<form method="post" action="/sign-out"><button class="bw-jarvis-text-button" type="submit">Sign out</button></form>');
      return secureHtml(html);
    } catch {
      return message("The Jarvis Boarding Roster is unavailable. Please try again later.", 502);
    }
  }
};
