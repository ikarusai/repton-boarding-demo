import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { demoAccounts } from '../demo-fixtures.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
let server, browser, temporary, origin;
const errors = [];
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'jarvis-browser-'));
  await mkdir(join(project, 'output/screenshots'), { recursive: true });
  server = spawn(process.execPath, ['demo-server.mjs', '--port', '0', '--state', join(temporary, 'state.json')], { cwd: project, stdio: ['ignore','pipe','pipe'] });
  origin = await new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(new Error('Demo startup timed out: ' + output)), 10000);
    server.stdout.on('data', data => { output += data; const match = /demo: (http:\/\/localhost:\d+)/.exec(output); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    server.stderr.on('data', data => { output += data; });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error('Demo exited ' + code + ': ' + output)); });
  });
  browser = await chromium.launch({ headless: true, channel: process.env.JARVIS_BROWSER_CHANNEL || 'chrome' });
});
after(async () => {
  await browser?.close();
  if (server?.exitCode === null) { const ended = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await ended; }
  await rm(temporary, { recursive: true, force: true });
});

async function signIn(page, index = 0) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/demo/sign-in');
  await page.locator('input[name=email]:not([type=hidden])').fill(demoAccounts[index].username);
  await page.locator('input[name=code]:not([type=hidden])').fill(demoAccounts[index].code);
  await page.locator('form[action="/sign-in"]').filter({has:page.locator('input[type=password]')}).locator('button').click();
  await page.waitForSelector('[data-welcome-name]');
  await page.waitForFunction(() => document.querySelector('[data-goal-status]')?.textContent.includes('saved to your account'));
}
async function navigate(page, name) {
  const menu = page.locator('.bw-menu [data-page="' + name + '"]');
  if (!await menu.isVisible()) await page.locator('.bw-menu-toggle').click();
  await menu.click();
}
async function createGoal(page, title) {
  const form = page.locator('[data-goal-form]');
  await form.locator('[name=title]').fill(title);
  await form.locator('[name=dueDate]').fill('2027-01-20');
  await form.locator('[name=milestoneTitle]').fill('Practise questions');
  await form.locator('[name=milestoneCriterion]').fill('Mark ten practice questions');
  await form.locator('[data-add-goal-step]').click();
  await form.locator('[name=milestoneTitle]').nth(1).fill('Review errors');
  await form.locator('[name=milestoneCriterion]').nth(1).fill('Explain three corrections');
  await form.locator('button[type=submit]').click();
  await page.waitForFunction(name => [...document.querySelectorAll('[data-goal-list] h3')].some(node => node.textContent === name), title);
  return page.locator('.jx-goal-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

test('public and authenticated pages enforce CSP, show fictional direct figures and keep boarders isolated', async () => {
  const a = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await a.newPage();
  const publicResponse = await page.goto(origin + '/demo/sign-in');
  assert.match(publicResponse.headers()['content-security-policy'], /nonce-/);
  assert.equal(await page.locator('#jarvis-fry-house-record').count(), 0);
  assert.equal((await page.request.get(origin + '/api/boarder-goals')).status(), 403);
  await signIn(page);
  assert.equal(await page.locator('[data-welcome-name]').textContent(), 'Avery');
  assert.equal(await page.locator('[data-active-house-points]').textContent(), '8');
  assert.equal((await page.request.get(origin + '/staff/sanctions')).status(), 403);
  const response = await page.request.get(origin + '/?studentId=demo-robin');
  assert.match(response.headers()['content-security-policy'], /script-src-attr 'none'/);
  assert.equal(response.headers()['cache-control'], 'private, no-store');
  const profile = await page.locator('#jarvis-fry-house-record').textContent();
  assert.doesNotMatch(profile, /Robin/);
  assert.equal(await page.evaluate(() => [...document.scripts].filter(s => s.type !== 'application/json').every(s => Boolean(s.nonce))), true);
  await page.screenshot({ path: join(project, 'output/screenshots/desktop-home.png'), fullPage: true });
  await a.close();
});

test('demo opens immediately without credentials and supports switching, reload and leaving an account', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForSelector('[data-welcome-name]');
  assert.equal(await page.locator('[data-welcome-name]').textContent(), 'Avery');
  assert.equal(await page.locator('input[type=password]:visible').count(), 0);
  assert.equal((await page.request.get(origin + '/staff/sanctions')).status(), 403);
  await page.getByRole('button', { name: 'Try Robin', exact: true }).click();
  await page.waitForSelector('[data-welcome-name]');
  assert.equal(await page.locator('[data-welcome-name]').textContent(), 'Robin');
  await page.reload(); await page.waitForSelector('[data-welcome-name]');
  assert.equal(await page.locator('[data-welcome-name]').textContent(), 'Robin');
  await page.getByRole('button', { name: 'Demo accounts', exact: true }).click();
  await page.waitForURL(origin + '/demo/choose');
  assert.equal(await page.locator('input:not([type=hidden])').count(), 0);
  assert.equal(await page.locator('#jarvis-fry-house-record').count(), 0);
  assert.equal((await page.request.get(origin + '/api/boarder-goals')).status(), 403);
  await page.getByRole('button', { name: 'Try Avery', exact: true }).first().click();
  await page.waitForSelector('[data-welcome-name]');
  assert.equal(await page.locator('[data-welcome-name]').textContent(), 'Avery');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(project, 'output/screenshots/demo-direct-entry.png'), fullPage: true });
  await context.close(); assert.deepEqual(errors, []);
});

test('embedded typefaces and painted orbs work publicly and privately, respecting reduced motion', async () => {
  const context = await browser.newContext({ viewport:{width:1440,height:1000}, reducedMotion:'no-preference' });
  const page = await context.newPage(), fontRequests = [];
  page.on('request', request => { if (request.resourceType() === 'font') fontRequests.push(request.url()); });
  await page.goto(origin + '/demo/sign-in');
  async function checkFonts() {
    const type = await page.evaluate(async () => {
      await Promise.all([document.fonts.load('450 28px Fraunces'),document.fonts.load('400 14px Inter')]);
      await document.fonts.ready;
      const faces = [...document.fonts].map(face => ({family:face.family,status:face.status}));
      const sources = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
        .filter(rule => rule instanceof CSSFontFaceRule)
        .map(rule => ({family:rule.style.fontFamily,embedded:rule.style.getPropertyValue('src').includes('data:font/woff2;base64,')}));
      return {faces,sources,heading:getComputedStyle(document.querySelector('h1')).fontFamily,
        field:getComputedStyle(document.querySelector('input:not([type=hidden])')).fontFamily};
    });
    for (const family of ['Fraunces','Inter']) {
      assert.ok(type.faces.some(face => face.family.replaceAll('"','') === family && face.status === 'loaded'));
      assert.ok(type.sources.some(face => face.family.replaceAll('"','') === family && face.embedded));
    }
    assert.match(type.heading,/Fraunces/); assert.match(type.field,/Inter/);
  }
  await checkFonts();
  const orb = page.locator('canvas[data-jarvis-orb]').first();
  await page.waitForFunction(() => document.querySelector('canvas[data-jarvis-orb]')?.dataset.orbRunning === 'true');
  assert.equal(await orb.evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    return canvas.dataset.orbPainted === 'true' && pixels.some((value,index) => index % 4 === 3 && value > 0);
  }),true);
  const moving = await orb.evaluate(canvas => canvas.toDataURL());
  await page.waitForFunction(previous => document.querySelector('canvas[data-jarvis-orb]').toDataURL() !== previous,moving,{timeout:3000});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(() => document.querySelector('canvas[data-jarvis-orb]')?.dataset.orbRunning === 'false');
  const still = await orb.evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(150);
  assert.equal(await orb.evaluate(canvas => canvas.toDataURL()),still);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(previous => document.querySelector('canvas[data-jarvis-orb]').toDataURL() !== previous,still,{timeout:3000});
  await signIn(page); await checkFonts();
  await page.waitForFunction(() => document.querySelector('canvas[data-jarvis-orb]')?.dataset.orbRunning === 'true');
  assert.equal(await page.locator('canvas[data-jarvis-orb]').first().getAttribute('data-orb-painted'),'true');
  await navigate(page,'goals');
  await page.waitForFunction(() => document.querySelector('canvas[data-jarvis-orb]')?.dataset.orbRunning === 'false');
  assert.ok(fontRequests.every(url => url.startsWith('data:') || url.startsWith(origin + '/')));
  await context.close(); assert.deepEqual(errors,[]);
});

test('supplied calendar appears in month/day views, searchable agenda and private RFC calendar download', async () => {
  const context = await browser.newContext({ acceptDownloads: true }); const page = await context.newPage();
  await signIn(page); await navigate(page, 'calendar');
  await page.locator('[data-house-plan]').click();
  assert.match(await page.locator('[data-week-label]').textContent(), /January 2027/);
  assert.match(await page.locator('[data-agenda-list]').textContent(), /X-Strike|Top Golf/);
  assert.doesNotMatch(await page.locator('[data-agenda-list]').textContent(), /Winter Break/);
  await page.locator('[data-calendar-search]').fill('Ski Dubai');
  assert.equal(await page.locator('[data-agenda-list] li').count(), 2);
  const downloaded = page.waitForEvent('download'); await page.locator('[data-calendar-export]').click();
  const download = await downloaded; const data = await readFile(await download.path(), 'utf8');
  assert.equal((data.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(data, /STATUS:TENTATIVE/); assert.match(data, /CLASS:PRIVATE/); assert.doesNotMatch(data, /DTSTART:.*T/);
  await page.locator('[data-agenda-list] button').first().click();
  assert.match(await page.locator('[data-week-grid]').textContent(), /Ski Dubai/);
  assert.match(await page.locator('[data-week-grid]').textContent(), /Time TBC/);
  await page.locator('[data-calendar-search]').fill('');
  await page.screenshot({ path: join(project, 'output/screenshots/calendar.png'), fullPage: true });
  await context.close();
});

test('goals create, evidence, weekly review, reopen, archive, restore and second-browser isolation', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  await signIn(page); await navigate(page, 'goals');
  let card = await createGoal(page, 'Browser biology goal');
  await card.getByText('Record completion', { exact: true }).first().click();
  await card.locator('textarea[name=evidence]').first().fill('Marked ten questions and corrected two answers.');
  await card.getByRole('button', { name: 'Save milestone', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-weekly-summary]').textContent.includes('1 milestone completed'));
  assert.match(await card.textContent(), /50%/);
  await page.getByText('Completed this week', { exact: true }).click();
  assert.match(await page.locator('[data-review-history]').textContent(), /Practise questions/);
  const second = await browser.newContext(); const otherPage = await second.newPage();
  await signIn(otherPage); await navigate(otherPage, 'goals');
  assert.match(await otherPage.locator('[data-goal-list]').textContent(), /Marked ten questions/);
  await second.close();
  const robin = await browser.newContext(); const robinPage = await robin.newPage();
  await signIn(robinPage, 1); await navigate(robinPage, 'goals');
  assert.doesNotMatch(await robinPage.locator('[data-goal-list]').textContent(), /Browser biology/);
  await robin.close();
  await card.getByRole('button', { name: 'Reopen milestone' }).click();
  await page.waitForFunction(() => document.querySelector('[data-weekly-summary]').textContent.includes('0 milestones'));
  await card.getByRole('button', { name: 'Archive goal', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.jx-goal-card').length === 0);
  await page.locator('[data-show-archived]').check();
  await page.getByRole('button', { name: 'Restore goal', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.jx-goal-card .jx-pill').textContent === '0%');
  await page.screenshot({ path: join(project, 'output/screenshots/goals.png'), fullPage: true });
  await context.close();
});

test('lost goal response retries the same operation; conflicting edit retains evidence and unrelated drafts', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  await signIn(page); await navigate(page, 'goals');
  let posts = 0, id;
  await page.route('**/api/boarder-goals', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; const body = route.request().postDataJSON();
    if (posts === 1) { id = body.operationId; await route.fetch(); return route.abort('failed'); }
    assert.equal(body.operationId, id); await route.continue();
  });
  const form = page.locator('[data-goal-form]');
  await form.locator('[name=title]').fill('Retry goal');
  await form.locator('[name=milestoneTitle]').fill('One step');
  await form.locator('[name=milestoneCriterion]').fill('Finish one question');
  await form.locator('button[type=submit]').click(); await page.locator('[data-goal-retry]').waitFor({ state:'visible' });
  assert.match(await page.locator('[data-goal-status]').textContent(), /kept in this tab/);
  assert.equal(await form.locator('[name=title]').inputValue(), 'Retry goal');
  assert.equal(await form.locator('[name=milestoneCriterion]').inputValue(), 'Finish one question');
  await page.locator('[data-goal-retry]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.jx-goal-card h3')].some(n => n.textContent === 'Retry goal'));
  assert.equal(posts, 2); await page.unroute('**/api/boarder-goals');
  const card = page.locator('.jx-goal-card').filter({has:page.getByRole('heading',{name:'Retry goal',exact:true})});
  await card.getByText('Record completion', { exact:true }).click();
  await card.locator('textarea').fill('My draft survives a stale revision.');
  const current = await (await page.request.get(origin + '/api/boarder-goals')).json();
  const goal = current.goals.find(item => item.title === 'Retry goal');
  const edited = await page.request.post(origin + '/api/boarder-goals', { headers: { Origin:origin }, data: { operationId:crypto.randomUUID(), action:'goal-edit', goalId:goal.id, previous:goal.revision, changes:{title:'Retry goal',category:goal.category,dueDate:'2027-01-23'} } });
  assert.equal(edited.status(), 200);
  await card.getByRole('button',{name:'Save milestone'}).click();
  await page.waitForFunction(() => document.querySelector('[data-goal-status]').textContent.includes('changed'));
  assert.equal(await card.locator('textarea').inputValue(), 'My draft survives a stale revision.');
  await page.locator('[data-goal-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-goal-status]').textContent.includes('saved to your account'));
  assert.equal(await card.locator('textarea').inputValue(), 'My draft survives a stale revision.');
  await card.getByRole('button',{name:'Save milestone'}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.jx-pill')].some(n => n.textContent === '100%'));
  await context.close();
});

test('existing personal calendar and revision plans persist through browser reload', async () => {
  const context = await browser.newContext(); const page = await context.newPage(); await signIn(page);
  await navigate(page, 'calendar');
  await page.locator('[data-calendar-search]').fill('no matching event');
  await page.locator('[data-event-open]').click();
  const form = page.locator('[data-event-form]');
  await form.locator('[name=title]').fill('Browser private reminder');
  await form.locator('[name=date]').fill('2027-01-10');
  await form.locator('[name=category]').selectOption('reminder');
  await form.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('[data-event-message]').textContent.includes('added to your calendar'));
  assert.equal(await page.locator('[data-calendar-search]').inputValue(), '');
  assert.match(await page.locator('[data-week-grid]').textContent(), /Browser private reminder/);
  await navigate(page, 'academic');
  await page.locator('[data-revision-form] [name=subject]').fill('Browser biology');
  await page.locator('[data-revision-form] [name=examDate]').fill('2027-01-20');
  await page.locator('[data-revision-form] button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-progress-status] [role=status]')].some(n => n.textContent.includes('saved to your account')));
  await page.reload(); await page.waitForFunction(() => document.querySelector('[data-goal-status]').textContent.includes('saved to your account'));
  assert.match(JSON.stringify(await (await page.request.get(origin + '/api/personal-calendar')).json()), /Browser private reminder/);
  assert.match(JSON.stringify(await (await page.request.get(origin + '/api/boarder-progress')).json()), /Browser biology/);
  await context.close();
});

test('mobile navigation, command palette, help, reduced motion and offline feedback remain usable', async () => {
  const context = await browser.newContext({ viewport:{width:390,height:844}, reducedMotion:'reduce' }); const page = await context.newPage();
  await signIn(page); await navigate(page,'goals');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({path:join(project,'output/screenshots/mobile-goals.png'),fullPage:true});
  await page.keyboard.press('Control+k');
  await page.locator('[data-command-search]').fill('calendar');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-screen=calendar]').isVisible(),true);
  await page.locator('[data-house-plan]').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await page.locator('#boarding-wellbeing-preview').getAttribute('data-animation-paused'),'true');
  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector('[data-connection-label]').textContent.includes('Offline'));
  assert.equal(await page.locator('[data-connection-label]').isVisible(), true);
  await context.setOffline(false);
  await page.locator('.bw-mobile-help').click();
  assert.equal(await page.locator('[data-screen=now]').isVisible(),true);
  await page.screenshot({path:join(project,'output/screenshots/mobile-help.png'),fullPage:true});
  await context.close();
});

test('initial private data requests still finish when document starts hidden', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => Object.defineProperty(document,'hidden',{get:()=>true,configurable:true}));
  const page = await context.newPage(); await signIn(page);
  assert.equal(await page.locator('#boarding-wellbeing-preview').getAttribute('data-animation-paused'),'true');
  assert.equal(await page.locator('canvas[data-jarvis-orb]').first().getAttribute('data-orb-running'),'false');
  assert.match(await page.locator('[data-goal-status]').textContent(), /saved to your account/);
  assert.match(await page.locator('[data-planner-status]').textContent(), /saved|account|calendar/i);
  await context.close();
  assert.deepEqual(errors, []);
});

test('wellbeing programme, keyboard stone collection and focus completion retain existing persistence', async () => {
  const context = await browser.newContext({reducedMotion:'reduce'}); const page = await context.newPage();
  await signIn(page); await navigate(page, 'wellbeing');
  await page.locator('[data-screen=wellbeing] [data-page=programme]').click();
  assert.equal(await page.locator('.jc-workshop').count(), 30);
  await navigate(page, 'wellbeing');
  await page.locator('[data-screen=wellbeing] [data-page=stones]').click();
  const stone = page.locator('[data-stone-grid] button').first(); await stone.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-progress-status] [role=status]')].some(n => n.textContent.includes('saved to your account')));
  let progress = (await (await page.request.get(origin + '/api/boarder-progress')).json()).progress;
  assert.ok(progress.stones.includes('emotions'));
  await navigate(page, 'academic'); await page.locator('[data-screen=academic] [data-page=study]').click();
  await page.clock.install();
  await page.locator('[data-study-form] [name=duration]').fill('1');
  await page.locator('[data-study-start]').click();
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => document.querySelector('[data-study-status]').textContent.includes('unlocked'));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-progress-status] [role=status]')].some(n => n.textContent.includes('saved to your account')));
  progress = (await (await page.request.get(origin + '/api/boarder-progress')).json()).progress;
  assert.equal(progress.study.minutes, 1); assert.ok(progress.study.landmarks.includes('burj'));
  await page.screenshot({path:join(project,'output/screenshots/focus-studio.png'),fullPage:true});
  await context.close(); assert.deepEqual(errors, []);
});

test('loading skeleton and orbit track real requests and request failures have a visible retry', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/boarder-goals', async route => { await gate; await route.continue(); });
  await page.goto(origin);
  await page.waitForSelector('[data-welcome-name]'); await navigate(page,'goals');
  assert.equal(await page.locator('[data-goal-skeleton]').isVisible(),true);
  assert.equal(await page.locator('[data-connection]').getAttribute('data-busy'),'true');
  assert.equal(await page.locator('canvas[data-jarvis-orb]').first().getAttribute('data-orb-busy'),'true');
  await page.screenshot({path:join(project,'output/screenshots/loading-state.png'),fullPage:true});
  release(); await page.waitForFunction(() => document.querySelector('[data-goal-status]').textContent.includes('saved to your account'));
  assert.equal(await page.locator('[data-goal-skeleton]').isVisible(),false);
  await page.waitForFunction(() => document.querySelector('canvas[data-jarvis-orb]')?.dataset.orbBusy === 'false');
  await page.unroute('**/api/boarder-goals');
  await context.close(); assert.deepEqual(errors,[]);
});

test('mobile milestone editor enforces row limits, validates fields and renders special characters as text', async () => {
  const context = await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  const page = await context.newPage(); await signIn(page, 1); await navigate(page, 'goals');
  const form = page.locator('[data-goal-form]'), rows = form.locator('[data-goal-step]');
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.locator('[data-remove-goal-step]').isVisible(), false);
  for (let index = 1; index < 8; index++) await form.locator('[data-add-goal-step]').click();
  assert.equal(await rows.count(), 8);
  assert.equal(await form.locator('[data-add-goal-step]').isDisabled(), true);
  await rows.nth(3).locator('[data-remove-goal-step]').click();
  assert.equal(await rows.count(), 7);
  assert.equal(await form.locator('[data-add-goal-step]').isEnabled(), true);
  assert.deepEqual(await form.locator('[data-step-label]').allTextContents(), Array.from({length:7},(_,i)=>'Milestone '+(i+1)));
  while (await rows.count() > 1) await rows.last().locator('[data-remove-goal-step]').click();
  const title = 'Read <img src=x onerror="alert(1)"> & explain it';
  const step = 'Solve x < 5 & y > 2';
  const criterion = 'Show five solutions | explain "why".';
  await form.locator('[name=title]').fill(title);
  await form.getByLabel('Milestone 1', {exact:true}).fill(step);
  await form.locator('button[type=submit]').click();
  assert.equal(await form.getByLabel('How will you know it is done?', {exact:true}).evaluate(input=>input.validity.valueMissing), true);
  assert.equal(await page.getByRole('heading', {name:title,exact:true}).count(), 0);
  await form.getByLabel('How will you know it is done?', {exact:true}).fill(criterion);
  await form.locator('button[type=submit]').click();
  await page.waitForFunction(text=>[...document.querySelectorAll('.jx-goal-card h3')].some(n=>n.textContent===text),title);
  const card = page.locator('.jx-goal-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  assert.equal(await card.locator('img').count(),0);
  assert.equal(await card.locator('.jx-milestones > li > strong').textContent(),step);
  assert.equal(await card.locator('.jx-milestones > li > p').textContent(),criterion);
  assert.equal(await rows.count(),1);
  assert.equal(await form.locator('[name=title]').inputValue(),'');
  assert.equal(await form.locator('[name=milestoneTitle]').inputValue(),'');
  assert.equal(await form.locator('[name=milestoneCriterion]').inputValue(),'');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.keyboard.press('Control+k');await page.locator('[data-command-search]').fill('My Stones');
  assert.equal(await page.locator('[data-command-list]').textContent(),'My Stones');
  await page.keyboard.press('Escape');
  await context.close();assert.deepEqual(errors,[]);
});
