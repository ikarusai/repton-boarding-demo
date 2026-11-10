// Inlined by build.mjs into the existing framework-free dashboard.
export function initEnhancements(context) {
  const { root, showPage, showCalendarDate, eventsOn, today, houseCalendar } = context;
  const q = selector => root.querySelector(selector);
  const node = (tag, text, className = '') => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    item.className = className;
    return item;
  };
  const control = (label, fn, className = 'bw-secondary') => {
    const item = node('button', label, className); item.type = 'button'; item.addEventListener('click', fn); return item;
  };
  const friendlyDate = date => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));

  // Keep actions and live status visible; put static guidance one click away.
  for (const paragraph of root.querySelectorAll('[data-screen] p')) {
    const screen = paragraph.closest('[data-screen]');
    if (['now', 'talk', 'home'].includes(screen.dataset.screen) || paragraph.closest('details, .bw-notice, [role="alert"], [role="status"]')) continue;
    if (paragraph.textContent.trim().length < 130 || paragraph.querySelector('a, button, input, [data-page]') ||
        [paragraph, ...paragraph.querySelectorAll('*')].some(element => [...element.attributes].some(attr => attr.name.startsWith('data-'))) || paragraph.querySelector('[role]')) continue;
    const details = node('details', undefined, 'jx-guidance');
    details.append(node('summary', 'How it works'));
    paragraph.before(details); details.append(paragraph);
  }

  // One lifecycle indicator for all private requests, including initial hidden-tab loads.
  const connection = q('[data-connection]');
  let requests = 0, failedRequests = new Set();
  function connectionState() {
    connection.dataset.busy = String(requests > 0);
    connection.dataset.offline = String(!navigator.onLine);
    q('[data-connection-label]').textContent = !navigator.onLine ? 'Offline · changes need a connection'
      : requests ? 'Syncing your workspace…' : failedRequests.size ? 'A save or load needs attention' : 'Workspace ready';
  }
  window.addEventListener('jarvis:request', event => {
    const { stage, path, ok } = event.detail;
    requests = Math.max(0, requests + (stage === 'start' ? 1 : -1));
    if (stage === 'end') { if (ok) failedRequests.delete(path); else failedRequests.add(path); }
    connectionState();
  });
  window.addEventListener('online', connectionState);
  window.addEventListener('offline', connectionState);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  function activityState() {
    root.dataset.animationPaused = String(document.hidden || motion.matches);
  }
  document.addEventListener('visibilitychange', activityState);
  motion.addEventListener('change', activityState);
  activityState(); connectionState();

  // Search, a dated agenda, clash checks and an explicit private calendar download.
  const search = q('[data-calendar-search]');
  const anchor = q('[data-agenda-start]');
  const horizon = q('[data-agenda-days]');
  anchor.value = today();
  function agenda() {
    if (!anchor.value) return [];
    return agendaEvents(eventsOn, anchor.value, Number(horizon.value), search.value);
  }
  function drawAgenda() {
    const entries = agenda(), list = q('[data-agenda-list]');
    list.replaceChildren();
    for (const entry of entries.slice(0, 100)) {
      const row = node('li');
      const open = control(entry.title, () => { showCalendarDate(entry.date, 'day'); q('[data-week-grid]').scrollIntoView({ block: 'start' }); }, 'jx-agenda-link');
      row.append(node('span', friendlyDate(entry.date) + ' · ' + (entry.time || (entry.sourceDocument && !['term','holiday'].includes(entry.category) ? 'Time not supplied' : 'All day')), 'jx-meta'), open);
      if (entry.detail) {
        const details = node('details', undefined, 'jx-guidance');
        details.append(node('summary', 'Details'), node('p', entry.detail, 'jx-meta'));
        row.append(details);
      }
      list.append(row);
    }
    q('[data-agenda-count]').textContent = entries.length ? entries.length + ' entries' + (entries.length > 100 ? ' · first 100 shown' : '') : 'No entries in this date range.';
    const clashes = eventClashes(anchor.value ? agendaEvents(eventsOn, anchor.value, Number(horizon.value)) : []);
    q('[data-agenda-clashes]').textContent = clashes.length ? clashes.length + ' timed overlap' + (clashes.length === 1 ? '' : 's') + ' in this date range (all events): ' + clashes.slice(0, 3).map(([a,b]) => a.title + ' / ' + b.title + ' on ' + friendlyDate(a.date)).join('; ')
      : 'No overlaps between known times. Entries without times and missing timetables cannot establish availability.';
    q('[data-calendar-export]').disabled = !entries.length;
  }
  search.addEventListener('input', () => { context.renderCalendar(); drawAgenda(); });
  anchor.addEventListener('change', drawAgenda); horizon.addEventListener('change', drawAgenda);
  q('[data-agenda-today]').addEventListener('click', () => { anchor.value = today(); drawAgenda(); });
  q('[data-house-plan]').addEventListener('click', () => {
    anchor.value = '2027-01-01'; horizon.value = '181'; search.value = '';
    showCalendarDate('2027-01-01', 'month'); drawAgenda();
  });
  q('[data-calendar-export]').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([calendarFile(agenda())], { type: 'text/calendar;charset=utf-8' }));
    const link = node('a'); link.href = url; link.download = 'jarvis-calendar-' + anchor.value + '.ics'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    q('[data-export-status]').textContent = 'Calendar file downloaded. It contains your selected private entries; keep it on a trusted device.';
  });
  window.addEventListener('jarvis:calendar', drawAgenda);
  if (houseCalendar) {
    q('[data-import-summary]').textContent = 'January–June 2027 · Awaiting school confirmation. Times TBC.';
    q('[data-import-notes]').replaceChildren(...houseCalendar.notes.map(note => node('li', note)));
  }
  drawAgenda();

  // Goals remain owned by the authenticated boarder; no identity is sent by this UI.
  let goals = [], review = null, busy = false, ready = false, pending = null, afterSave = null;
  const form = q('[data-goal-form]'), goalList = q('[data-goal-list]'), goalStatus = q('[data-goal-status]');
  const retry = q('[data-goal-retry]'), archived = q('[data-show-archived]');
  const empty = q('[data-goals-empty]');
  const drafts = new Map();
  const stepList = q('[data-goal-steps]'), addStep = q('[data-add-goal-step]');
  const stepRows = () => [...stepList.querySelectorAll('[data-goal-step]')];
  function updateStepControls() {
    const rows = stepRows();
    rows.forEach((row, index) => {
      row.querySelector('[data-step-label]').textContent = 'Milestone ' + (index + 1);
      const remove = row.querySelector('[data-remove-goal-step]');
      remove.hidden = rows.length === 1;
      remove.setAttribute('aria-label', 'Remove milestone ' + (index + 1));
    });
    addStep.disabled = busy || !ready || Boolean(pending) || rows.length >= 8;
  }
  function appendStep(focus = false) {
    if (stepRows().length >= 8) return;
    const row = node('fieldset', undefined, 'jx-goal-step'); row.dataset.goalStep = '';
    const titleLabel = node('label'), titleText = node('span'); titleText.dataset.stepLabel = '';
    const title = node('input'); title.name = 'milestoneTitle'; title.required = true; title.maxLength = 120;
    title.placeholder = 'Practise cell biology'; titleLabel.append(titleText, title);
    const criterionLabel = node('label', 'How will you know it is done?');
    const criterion = node('textarea'); criterion.name = 'milestoneCriterion'; criterion.required = true; criterion.maxLength = 240; criterion.rows = 2;
    criterion.placeholder = 'Finish and mark ten practice questions'; criterionLabel.append(criterion);
    const remove = control('Remove', () => {
      if (busy || pending || stepRows().length <= 1) return;
      const index = stepRows().indexOf(row); row.remove(); updateStepControls();
      stepRows()[Math.min(index, stepRows().length - 1)].querySelector('input').focus();
    }, 'bw-secondary jx-remove-step'); remove.dataset.removeGoalStep = '';
    row.append(titleLabel, criterionLabel, remove); stepList.append(row); updateStepControls();
    if (focus) title.focus();
  }
  function resetGoalForm() {
    form.reset(); stepList.replaceChildren(); appendStep();
  }
  addStep.addEventListener('click', () => {
    if (!busy && ready && !pending) appendStep(true);
  });
  appendStep();
  function captureDrafts() {
    for (const input of goalList.querySelectorAll('[data-goal-draft]')) {
      if (input.value !== (input.dataset.serverValue || '')) drafts.set(input.dataset.goalDraft, input.value);
      else drafts.delete(input.dataset.goalDraft);
    }
  }
  function saveState(message) {
    goalStatus.textContent = message;
    retry.hidden = busy || (ready && !pending);
    retry.textContent = pending ? 'Retry this save' : 'Retry loading';
    q('[data-goal-skeleton]').hidden = ready || !busy;
    goalList.setAttribute('aria-busy', String(busy));
    archived.disabled = busy || Boolean(pending);
    q('[data-goal-refresh]').disabled = busy || Boolean(pending);
    for (const field of form.elements) field.disabled = busy || !ready || Boolean(pending);
    for (const field of goalList.querySelectorAll('button,input,textarea,select')) field.disabled = busy || Boolean(pending);
    updateStepControls();
  }
  function fillReview() {
    const active = goals.filter(goal => !goal.archived);
    const complete = active.filter(goal => goal.status === 'complete' || goal.percent === 100);
    q('[data-goals-summary]').textContent = active.length ? complete.length + ' of ' + active.length + (active.length === 1 ? ' goal achieved' : ' goals achieved') : 'Choose something worth working towards.';
    const due = active.filter(goal => goal.percent < 100 && goal.dueDate && goal.dueDate <= shiftDay(today(), 7));
    q('[data-weekly-summary]').textContent = review ? review.completedMilestones + (review.completedMilestones === 1 ? ' milestone completed · ' : ' milestones completed · ') + review.achievedGoals + (review.achievedGoals === 1 ? ' goal achieved this week' : ' goals achieved this week') : 'Your week will appear after goals load.';
    q('[data-review-period]').textContent = review ? friendlyDate(review.weekStart) + ' – ' + friendlyDate(review.weekEnd) + ' · Dubai' : 'This week · Dubai';
    q('[data-goal-next]').replaceChildren(...active.filter(goal => goal.percent < 100).slice(0, 3).map(goal => {
      const item = node('li');
      item.append(node('strong', goal.title), node('span', goal.nextMilestone?.title || goal.milestones.find(m => !m.done)?.title || 'Review this goal', 'jx-meta'));
      if (goal.dueDate) item.append(node('span', (goal.dueDate < today() ? 'Overdue · ' : 'Target · ') + friendlyDate(goal.dueDate), 'jx-meta'));
      return item;
    }));
    q('[data-review-due]').textContent = due.length ? due.length + (due.length === 1 ? ' open goal has a target date within the next seven days or is overdue.' : ' open goals have a target date within the next seven days or are overdue.') : 'No open goals due in the next seven days.';
    const history = review?.entries || [];
    q('[data-review-history]').replaceChildren(...history.slice(0, 20).map(entry => node('li', [entry.goalTitle, entry.title, entry.evidence].filter(Boolean).join(' · '))));
  }
  function renderGoals(preserveDrafts = true) {
    if (preserveDrafts) captureDrafts();
    goalList.replaceChildren();
    const visible = goals.filter(goal => archived.checked || !goal.archived);
    empty.hidden = visible.length > 0 || !ready;
    for (const goal of visible) {
      const card = node('article', undefined, 'jx-goal-card'); card.dataset.goalId = goal.id;
      const top = node('div', undefined, 'jx-goal-heading');
      top.append(node('h3', goal.title), node('span', goal.archived ? 'Archived' : goal.percent + '%', 'jx-pill'));
      card.append(top, node('p', goal.category + (goal.dueDate ? ' · Target ' + friendlyDate(goal.dueDate) : ''), 'jx-meta'));
      const meter = node('progress'); meter.max = 100; meter.value = goal.percent; meter.setAttribute('aria-label', goal.title + ' progress'); card.append(meter);
      const milestones = node('ol', undefined, 'jx-milestones');
      for (const milestone of goal.milestones) {
        const item = node('li');
        item.append(node('strong', milestone.title), node('p', milestone.criterion, 'jx-meta'));
        if (milestone.done) {
          item.append(node('p', 'Completed · ' + milestone.evidence, 'jx-evidence'));
          if (!goal.archived) item.append(control('Reopen milestone', () => change({ action: 'goal-milestone', goalId: goal.id, previous: goal.revision, milestoneId: milestone.id, done: false, evidence: '' })));
        } else if (!goal.archived) {
          const details = node('details'), evidenceForm = node('form');
          details.append(node('summary', 'Record completion'));
          const label = node('label', 'What did you complete?'); const input = node('textarea');
          input.name = 'evidence'; input.required = true; input.maxLength = 500; input.rows = 2; label.append(input);
          input.dataset.goalDraft = goal.id + '/' + milestone.id;
          input.value = drafts.get(input.dataset.goalDraft) || '';
          details.open = Boolean(input.value);
          const submit = node('button', 'Save milestone', 'bw-primary-button'); submit.type = 'submit';
          evidenceForm.append(label, submit);
          evidenceForm.addEventListener('submit', event => { event.preventDefault(); if (evidenceForm.reportValidity()) change({ action: 'goal-milestone', goalId: goal.id, previous: goal.revision, milestoneId: milestone.id, done: true, evidence: input.value.trim() }); });
          details.append(evidenceForm); item.append(details);
        }
        milestones.append(item);
      }
      card.append(milestones);
      const actions = node('div', undefined, 'bw-action-row');
      actions.append(control(goal.archived ? 'Restore goal' : 'Archive goal', () => change({ action: 'goal-archive', goalId: goal.id, previous: goal.revision, archived: !goal.archived })));
      if (!goal.archived) {
        const edit = node('details'), editForm = node('form'); edit.append(node('summary', 'Edit goal'));
        for (const [name, title, type, value] of [['title', 'Goal title', 'text', goal.title], ['dueDate', 'Target date', 'date', goal.dueDate]]) {
          const label = node('label', title), input = node('input'); input.name = name; input.type = type;
          input.dataset.goalDraft = goal.id + '/edit/' + name;
          input.dataset.serverValue = value || '';
          input.value = drafts.get(input.dataset.goalDraft) ?? value ?? ''; input.maxLength = 120; input.required = name === 'title'; label.append(input); editForm.append(label);
          if (drafts.has(input.dataset.goalDraft) && input.value !== (value || '')) edit.open = true;
        }
        const submit = node('button', 'Save details', 'bw-secondary'); submit.type = 'submit'; editForm.append(submit);
        editForm.addEventListener('submit', event => { event.preventDefault(); if (editForm.reportValidity()) change({ action: 'goal-edit', goalId: goal.id, previous: goal.revision, changes: { title: editForm.elements.title.value.trim(), dueDate: editForm.elements.dueDate.value, category: goal.category } }); });
        edit.append(editForm); actions.append(edit);
      }
      card.append(actions); goalList.append(card);
    }
    fillReview();
  }
  async function sync() {
    if (busy) return;
    captureDrafts();
    busy = true; saveState(pending ? 'Saving your goal…' : 'Loading your goals…');
    try {
      if (!window.jarvisBoarderGoals) throw new Error('Open the local demo or sign in to save goals.');
      const result = await window.jarvisBoarderGoals(pending);
      goals = result.goals; review = result.review; ready = true;
      const savedGoalId = pending?.goalId || pending?.goal?.id;
      if (pending?.action === 'goal-edit') for (const key of drafts.keys()) if (key.startsWith(savedGoalId + '/edit/')) drafts.delete(key);
      if (pending?.action === 'goal-milestone') drafts.delete(savedGoalId + '/' + pending.milestoneId);
      pending = null;
      if (afterSave) { afterSave(); afterSave = null; }
      renderGoals(false);
      goalStatus.textContent = 'Goals saved to your account.';
    } catch (error) {
      if (error.status === 409 && Array.isArray(error.result?.goals)) {
        goals = error.result.goals; review = error.result.review; ready = true; pending = null; afterSave = null; renderGoals();
        goalStatus.textContent = error.message || 'This goal changed on another device. Review the latest version, then try again.';
      } else if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        pending = null; afterSave = null; goalStatus.textContent = error.message;
      } else goalStatus.textContent = error.message + (pending ? ' Your change is kept in this tab. Retry the same save.' : '');
    } finally { busy = false; saveState(goalStatus.textContent); }
  }
  function change(operation, onSuccess) {
    if (busy || pending || !ready) return;
    pending = { operationId: crypto.randomUUID(), ...operation }; afterSave = onSuccess || null; sync();
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const milestones = stepRows().map(row => ({ id: crypto.randomUUID(),
      title: row.querySelector('[name=milestoneTitle]').value.trim(),
      criterion: row.querySelector('[name=milestoneCriterion]').value.trim() }));
    if (!milestones.length || milestones.length > 8 || milestones.some(item => !item.title || !item.criterion)) {
      goalStatus.textContent = 'Give each milestone an action and a clear finish line.'; return;
    }
    const id = crypto.randomUUID();
    change({ operationId: id, action: 'goal-create', goal: { id, title: form.elements.title.value.trim(), category: form.elements.category.value, dueDate: form.elements.dueDate.value, milestones } }, resetGoalForm);
  });
  retry.addEventListener('click', sync); archived.addEventListener('change', () => { renderGoals(); saveState(goalStatus.textContent); });
  q('[data-goal-refresh]').addEventListener('click', () => { if (!pending) sync(); });
  window.addEventListener('beforeunload', event => { if (pending) { event.preventDefault(); event.returnValue = ''; } });
  renderGoals(); sync();
  let reviewDay = today();
  window.addEventListener('jarvis:calendar', () => {
    if (reviewDay !== today()) { reviewDay = today(); if (ready && !busy && !pending) sync(); }
  });

  // Searchable keyboard navigation uses native dialog focus management.
  const dialog = q('[data-command-dialog]'), commandInput = q('[data-command-search]'), commandList = q('[data-command-list]');
  const commands = [['Command Centre', 'home'], ['Calendar', 'calendar'], ['Goals and milestones', 'goals'], ['Weekly review', 'goals'], ['Revision planner', 'academic'], ['Study with me', 'study'], ['My Stones', 'stones'], ['Wellbeing programme', 'programme'], ['Help now', 'now']];
  function drawCommands() {
    commandList.replaceChildren(...commands.filter(([name]) => name.toLowerCase().includes(commandInput.value.toLowerCase())).map(([name,page]) => {
      const item = node('li'); item.append(control(name, () => { dialog.close(); showPage(page); if (name === 'Weekly review') q('[data-weekly-review]').scrollIntoView(); })); return item;
    }));
    if (!commandList.children.length) commandList.append(node('li', 'No matching pages.'));
  }
  function openCommands() { commandInput.value = ''; drawCommands(); dialog.showModal(); commandInput.focus(); }
  q('[data-open-commands]').addEventListener('click', openCommands);
  q('[data-close-commands]').addEventListener('click', () => dialog.close());
  commandInput.addEventListener('input', drawCommands);
  commandInput.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); commandList.querySelector('button')?.focus(); } });
  dialog.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || document.activeElement === commandInput) return;
    const buttons = [...commandList.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (index >= 0) { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
  });
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); dialog.open ? dialog.close() : openCommands(); } });
}
