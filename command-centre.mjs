import { commandCentreStyle, particleOrbScript, reptonBrandingScript } from "./page.generated.mjs";

const termDatesUrl = "https://www.reptondubai.org/term-dates/";
const schoolContactUrl = "https://www.reptondubai.org/contact-us/";
const termDates = [
  ["2026-12-04", "2–4 Dec", "National Day holiday · provisional"],
  ["2026-12-11", "11 Dec", "Winter term ends"],
  ["2027-01-04", "4 Jan", "Spring term begins"],
  ["2027-04-02", "2 Apr", "Spring term ends"],
  ["2027-04-12", "12 Apr", "Summer term begins"],
  ["2027-07-02", "2 Jul", "Summer term ends"],
];
const dubaiDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Dubai", dateStyle: "short" });

export function publicCommandCentre(headers, enabled, status = 200, invalid = false) {
  const now = new Date();
  const today = dubaiDay.format(now);
  const nonce = crypto.randomUUID();
  const upcoming = termDates.filter(([through]) => through >= today).slice(0, 4);
  const rows = upcoming.length ? upcoming.map(([, date, title]) => `<li><span>${date}</span><strong>${title}</strong></li>`).join("")
    : "<li><strong>See the Repton calendar for the latest dates.</strong></li>";
  const form = enabled ? `<form method="post" action="/sign-in" class="jc-public-form jl-public-form">
    <label for="jl-username">School username<input id="jl-username" name="email" placeholder="firstname.surname" maxlength="150" autocomplete="username" autocapitalize="none" spellcheck="false" required${invalid ? ' aria-describedby="jl-login-error" autofocus' : ""}></label>
    <label for="jl-code">Access code<input id="jl-code" type="password" name="code" maxlength="64" autocomplete="current-password" required${invalid ? ' aria-describedby="jl-login-error"' : ""}></label>
    <button type="submit">Open my Jarvis <span aria-hidden="true">↗</span></button>
    <p class="jl-public-form-note">Use the individual code from your house tutor. Your school email works too.</p>
  </form>` : '<p class="jl-public-setup" role="status">School sign-in is awaiting setup. Ask your house tutor when access will be available.</p>';
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarvis Boarding Command Centre</title>
<style>${commandCentreStyle}</style></head>
<body class="jc-body"><div id="boarding-wellbeing-preview"><div class="jc-shell jc-public jl-public">
  <header class="jl-public-header">
    <a class="jl-public-brand" href="/" aria-label="Jarvis home"><span class="jl-brand-dot" aria-hidden="true"></span><strong>Jarvis</strong><span>Fry House</span></a>
    <nav class="jl-public-nav" aria-label="Jarvis navigation">
      <a href="#calendar">School calendar</a>
      <a href="#support">Support</a>
      <a href="#sign-in" class="jl-public-signin-link">Sign in</a>
    </nav>
    <time class="jl-public-clock" datetime="${now.toISOString()}" aria-label="Dubai time"><strong data-public-time></strong><span data-public-date>Dubai time</span></time>
  </header>
  <main class="jl-public-main">
    <section class="jl-public-hero" aria-labelledby="jc-public-title">
      <div class="jl-public-intro">
        <div class="jarvis-orb jl-public-orb" aria-hidden="true"><canvas data-jarvis-orb aria-hidden="true"></canvas></div>
        <p class="jl-eyebrow">Repton Dubai · Fry House</p>
        <h1 id="jc-public-title">Your day,<br>a little clearer.</h1>
        <p class="jl-public-description">Your calendar, your goals, and a place to start. A quieter way to keep track of boarding life.</p>
      </div>
      <section class="jl-public-signin" id="sign-in" aria-labelledby="jc-sign-in-title">
        <p class="jl-eyebrow">Your own space</p><h2 id="jc-sign-in-title">Welcome back.</h2>
        <p>Sign in to see your timetable, school record and saved plans.</p>
        ${invalid ? '<p id="jl-login-error" class="jl-public-error" role="alert">The username or access code didn’t match. Check both and try again.</p>' : ""}
        ${form}
        <a class="jl-public-help" href="#support">Need a hand signing in?</a>
      </section>
    </section>
    <div class="jl-public-columns">
      <section id="calendar" aria-labelledby="jl-public-calendar-title">
        <div class="jl-section-heading"><div><p class="jl-eyebrow">Looking ahead</p><h2 id="jl-public-calendar-title">Dates to know.</h2></div><span class="jl-public-year">2026–27</span></div>
        <ul class="jl-public-dates">${rows}</ul>
        <a href="${termDatesUrl}">Published term dates <span aria-hidden="true">↗</span></a>
      </section>
      <section aria-labelledby="jl-public-timings-title">
        <p class="jl-eyebrow">Years 7–13</p><h2 id="jl-public-timings-title">The school day.</h2>
        <dl class="jl-public-timings">
          <div><dt>Monday to Thursday</dt><dd>07:30–15:00</dd></div>
          <div><dt>Clubs and sports · Mon–Thu</dt><dd>15:15–16:15</dd></div>
          <div><dt>Friday · arrival from 07:15</dt><dd>Pickup at 11:30</dd></div>
        </dl>
        <a href="https://www.reptondubai.org/school-timings/">Published school timings <span aria-hidden="true">↗</span></a>
      </section>
    </div>
    <section class="jl-public-support" id="support" aria-labelledby="jl-support-title">
      <div><p class="jl-eyebrow">Someone is here to help</p><h2 id="jl-support-title">You don’t have to figure it out alone.</h2><p>For immediate help, go to a member of staff or the duty adult. For account access, ask your house tutor.</p></div>
      <a href="${schoolContactUrl}">Contact Repton <span aria-hidden="true">↗</span></a>
    </section>
    <footer class="jl-public-footer" id="links"><span>Fry House · Leave no stone unturned</span><nav aria-label="School links"><a href="https://www.reptondubai.org/">Repton Dubai ↗</a><a href="https://reptondubai.reach.cloud/">REACH Boarding ↗</a></nav></footer>
  </main>
</div></div>
<script nonce="${nonce}">
  ${particleOrbScript}
  ${reptonBrandingScript}
  initReptonBranding(document);
  initJarvisOrbs(document);
  const clock = document.querySelector("[data-public-time]");
  const date = document.querySelector("[data-public-date]");
  const formatTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" });
  const formatDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", year: "numeric" });
  function tick() {
    const now = new Date();
    clock.textContent = formatTime.format(now);
    date.textContent = formatDate.format(now) + " · Dubai";
    clock.parentElement.dateTime = now.toISOString();
  }
  tick();
  setInterval(tick, 1000);
</script></body></html>`, { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` } });
}
