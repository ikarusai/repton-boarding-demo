import { readFile, writeFile } from "node:fs/promises";
import wellbeingProgramme from "./wellbeing-programme.mjs";
import { projectHouseCalendar } from "./house-calendar.mjs";

const fragmentPath = process.argv[2];
if (!fragmentPath) throw new Error("Pass the path to the current Jarvis HTML fragment.");
const fragment = await readFile(fragmentPath, "utf8");
const [style, globe, enhancementStyle, plannerTools, enhancements, theme, orbStyle, orbSource, fraunces, inter, brandingStyle, brandingSource, crest] = await Promise.all([
  readFile(new URL("./command-centre.css", import.meta.url), "utf8"),
  readFile(new URL("./command-centre-globe.svg", import.meta.url), "utf8"),
  readFile(new URL("./enhancements.css", import.meta.url), "utf8"),
  readFile(new URL("./planner-tools.mjs", import.meta.url), "utf8"),
  readFile(new URL("./enhancements.mjs", import.meta.url), "utf8"),
  readFile(new URL("./jarvis-theme.css", import.meta.url), "utf8"),
  readFile(new URL("./particle-orb.css", import.meta.url), "utf8"),
  readFile(new URL("./particle-orb.mjs", import.meta.url), "utf8"),
  readFile(new URL("./assets/fonts/fraunces-latin.woff2", import.meta.url)),
  readFile(new URL("./assets/fonts/inter-latin.woff2", import.meta.url)),
  readFile(new URL("./repton-branding.css", import.meta.url), "utf8"),
  readFile(new URL("./repton-branding.mjs", import.meta.url), "utf8"),
  readFile(new URL("./assets/repton/repton-crest.png", import.meta.url)),
]);
const fontStyle = `@font-face{font-family:Fraunces;font-style:normal;font-weight:400 600;font-display:swap;src:url(data:font/woff2;base64,${fraunces.toString('base64')}) format('woff2')}\n@font-face{font-family:Inter;font-style:normal;font-weight:400 700;font-display:swap;src:url(data:font/woff2;base64,${inter.toString('base64')}) format('woff2')}`;
const commandCentreStyle = fontStyle + '\n' + style.replace("__JARVIS_GLOBE__", "data:image/svg+xml," + encodeURIComponent(globe)) + '\n' + enhancementStyle + '\n' + orbStyle + '\n' + theme + '\n' + brandingStyle;
const particleOrbScript = orbSource.replace(/^export /gm, '');
const reptonBrandingScript = brandingSource.replace('__REPTON_CREST_DATA_URL__', 'data:image/png;base64,' + crest.toString('base64')).replace(/^export /gm, '');
const programmeData = '<script type="application/json" id="fry-wellbeing-programme">' +
  JSON.stringify(wellbeingProgramme).replace(/</g, "\\u003c") + "</script>";
const calendarData = '<script type="application/json" id="fry-house-calendar">' + JSON.stringify(projectHouseCalendar(10)).replace(/</g, "\\u003c") + '</script>';
const enhancementCode = '<script>(() => {\n' + (plannerTools + '\n' + enhancements).replace(/^export /gm, '') + '\n' + particleOrbScript + '\n' + reptonBrandingScript + '\nwindow.initReptonBranding = initReptonBranding; window.initJarvisOrbs = initJarvisOrbs; window.jarvisEnhancements = initEnhancements; window.jarvisMatchesEvent = matchesEvent; window.jarvisOutsideCoverage = outsideCoverage;\n})();</script>';
if (!fragment.includes('id="boarding-wellbeing-preview"') || !fragment.includes("jarvis-fry-house-record")) {
  throw new Error("The Jarvis fragment must support Fry House profiles.");
}
// The hosted Worker uses school sign-in. Leave the preview's password verifier out of its page.
const previewLogin = /^  staffLogin\.addEventListener\("submit", async event => \{\n[\s\S]*?^  \}\);\n/m;
if (!previewLogin.test(fragment)) throw new Error("The Jarvis preview login has changed. Review the hosted build.");
const hostedFragment = fragment.replace(previewLogin, '  staffLogin.addEventListener("submit", event => event.preventDefault());\n');
const plannerBridge = String.raw`<script>
async function jarvisPlannerRequest(path, field, valid, operation) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const options = { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal };
  if (operation) {
    options.method = "POST";
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(operation);
  }
  let ok = false;
  window.dispatchEvent(new CustomEvent('jarvis:request', { detail: { path, stage: 'start' } }));
  try {
  const response = await fetch(path, options);
  const result = response.headers.get("Content-Type")?.includes("application/json") ? await response.json() : {};
  if (!response.ok || !valid(field ? result[field] : result)) {
    const failure = new Error(result.error || "Sign in again or retry to load your saved changes.");
    failure.status = response.status;
    failure[field] = result[field];
    failure.result = result;
    throw failure;
  }
  ok = true;
  return field ? result[field] : result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The connection timed out. Please retry.');
    throw error;
  } finally {
    clearTimeout(timeout);
    window.dispatchEvent(new CustomEvent('jarvis:request', { detail: { path, stage: 'end', ok } }));
  }
}
window.jarvisPersonalCalendar = operation => jarvisPlannerRequest("/api/personal-calendar", "events", Array.isArray, operation);
window.jarvisBoarderProgress = operation => jarvisPlannerRequest("/api/boarder-progress", "progress", value =>
  Array.isArray(value?.plans) && Array.isArray(value?.stones) && Array.isArray(value?.study?.landmarks), operation);
window.jarvisBoarderGoals = operation => jarvisPlannerRequest('/api/boarder-goals', '', value => Array.isArray(value?.goals) && value.review, operation);
</script>`;
const page = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Jarvis Boarding Command Centre</title></head><body class="jc-body"><!-- JARVIS_PROFILE -->' +
  plannerBridge + programmeData + calendarData + enhancementCode + hostedFragment;
await writeFile(new URL("./page.generated.mjs", import.meta.url),
  "export const commandCentreStyle = " + JSON.stringify(commandCentreStyle) + ";\n" +
  "export const particleOrbScript = " + JSON.stringify(particleOrbScript) + ";\n" +
  "export const reptonBrandingScript = " + JSON.stringify(reptonBrandingScript) + ";\n" +
  "export default " + JSON.stringify(page) + ' + "<style>" + commandCentreStyle + "</style></body></html>";\n');
