import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { projectGoals, serveBoarderGoals, weeklyGoalReview } from "./boarder-goals.mjs";
import { serveBoarderProgress } from "./boarder-progress.mjs";
import { normalizeGoalOperation } from "./progress-operations.mjs";

const columns = ["Student ID", "Operation ID", "Progress JSON", "Saved at"];
const origin = "https://jarvis.example.invalid";
const headers = { "Cache-Control": "private, no-store" };
const env = {
  JARVIS_PLANNER_SPREADSHEET_ID: "fictional-private-goal-planner",
  JARVIS_SHEETS_BRIDGE_URL: "https://script.google.com/macros/s/fictional-goals/exec",
  JARVIS_SHEETS_BRIDGE_KEY: "1".repeat(64)
};
const create = (title = "Build a steady revision routine") => {
  const id = randomUUID();
  return { operationId: id, action: "goal-create", goal: { id, title, category: "academics", dueDate: "2027-02-28",
    milestones: [{ id: randomUUID(), title: "Complete the first practice paper", criterion: "One marked paper with corrections recorded" },
      { id: randomUUID(), title: "Review weak topics", criterion: "Explain the corrected answers without notes" }] } };
};
const change = (goal, action, fields) => ({ operationId: randomUUID(), action, goalId: goal.id, previous: goal.revision, ...fields });
const row = (operation, owner = "boarder-a", at = "2027-01-10T21:00:00.000Z") => {
  const { operationId, ...data } = operation;
  return [owner, operationId, JSON.stringify(data), at];
};
const request = (operation, requestHeaders = {}) => new Request(origin + "/api/boarder-goals?studentId=boarder-b", operation ? {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...requestHeaders },
  body: typeof operation === "string" ? operation : JSON.stringify({ ...operation, studentId: "boarder-b" })
} : {});

async function fixture(run) {
  const previousFetch = globalThis.fetch;
  const rows = [columns.slice()];
  const state = { rows, loseResponse: false, beforeAppend: null, reads: 0 };
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), env.JARVIS_SHEETS_BRIDGE_URL);
    const call = JSON.parse(JSON.parse(options.body).payload);
    assert.equal(call.tab, "progress");
    if (call.operation === "append") {
      assert.equal(call.row.length, 4);
      assert.equal(call.row[0], call.studentId);
      if (state.beforeAppend) {
        const callback = state.beforeAppend;
        state.beforeAppend = null;
        callback(call.row);
      }
      rows.push(call.row);
      if (state.loseResponse) throw new Error("Response lost after commit");
      return Response.json({ ok: true });
    }
    state.reads++;
    return Response.json({ ok: true, rows });
  };
  try { await run(state); } finally { globalThis.fetch = previousFetch; }
}

test("goals persist through response loss, retain evidence, reopen, edit, archive and restore", async () => fixture(async state => {
  const call = operation => serveBoarderGoals(request(operation), env, "boarder-a", headers);
  const creation = create();
  state.loseResponse = true;
  await assert.rejects(call(creation), /Response lost after commit/);
  state.loseResponse = false;
  const replay = await call(creation);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("Cache-Control"), "private, no-store");
  assert.equal(state.rows.length, 2);
  let goal = (await replay.json()).goals[0];
  assert.equal(goal.percent, 0);
  assert.equal(goal.nextMilestone.id, creation.goal.milestones[0].id);
  assert.equal((await call({ ...creation, goal: { ...creation.goal, title: "A different goal" } })).status, 409);

  const complete = change(goal, "goal-milestone", { milestoneId: goal.milestones[0].id, done: true, evidence: "Marked paper saved in my folder." });
  goal = (await (await call(complete)).json()).goals[0];
  assert.equal(goal.percent, 50);
  assert.equal(goal.milestones[0].evidence, complete.evidence);
  assert.ok(goal.milestones[0].completedAt);
  assert.equal((await call(complete)).status, 200);
  assert.equal(state.rows.length, 3);
  goal = (await (await call(change(goal, "goal-milestone", {
    milestoneId: goal.milestones[0].id, done: false, evidence: ""
  }))).json()).goals[0];
  assert.equal(goal.percent, 0);
  assert.equal(goal.milestones[0].completedAt, null);
  assert.equal(goal.milestones[0].evidence, "");

  goal = (await (await call(change(goal, "goal-edit", { changes: {
    title: "A practical revision routine", category: "wellbeing", dueDate: ""
  } }))).json()).goals[0];
  assert.equal(goal.title, "A practical revision routine");
  goal = (await (await call(change(goal, "goal-archive", { archived: true }))).json()).goals[0];
  assert.equal(goal.status, "archived");
  assert.equal((await call(change(goal, "goal-milestone", {
    milestoneId: goal.milestones[0].id, done: true, evidence: "A review note."
  }))).status, 409);
  goal = (await (await call(change(goal, "goal-archive", { archived: false }))).json()).goals[0];
  assert.equal(goal.status, "active");
  assert.ok(state.rows.slice(1).every(saved => saved[0] === "boarder-a"));
}));

test("goal revisions reject stale edits and a race winner remains authoritative", async () => fixture(async state => {
  const call = operation => serveBoarderGoals(request(operation), env, "boarder-a", headers);
  const creation = create();
  const goal = (await (await call(creation)).json()).goals[0];
  const first = change(goal, "goal-edit", { changes: { title: "First editor", category: "academics", dueDate: "2027-03-01" } });
  const second = change(goal, "goal-edit", { changes: { title: "Second editor", category: "sport", dueDate: "2027-04-01" } });
  state.beforeAppend = () => state.rows.push(row(first));
  const raced = await call(second);
  assert.equal(raced.status, 409);
  assert.equal((await raced.json()).goals[0].title, "First editor");
  assert.equal((await call(second)).status, 409);
  assert.equal((await call(first)).status, 200);
  const count = state.rows.length;
  assert.equal((await call(change(goal, "goal-archive", { archived: true }))).status, 409);
  assert.equal(state.rows.length, count);
}));

test("shared progress log isolates owners and accepts only valid operations from either feature", async () => fixture(async state => {
  const creation = create();
  state.rows.push(row(creation), row(create("Another boarder's goal"), "boarder-b"),
    row({ operationId: randomUUID(), action: "collect-stone", stone: "emotions" }));
  const saved = await serveBoarderGoals(request(), env, "boarder-a", headers);
  assert.deepEqual((await saved.json()).goals.map(goal => goal.title), [creation.goal.title]);
  const progress = await serveBoarderProgress(request(), env, "boarder-a", headers);
  assert.deepEqual((await progress.json()).progress.stones, ["emotions"]);
  assert.equal((await (await serveBoarderGoals(request(), env, "boarder-c", headers)).json()).goals.length, 0);
  const hostile = change({ id: creation.goal.id, revision: creation.operationId }, "goal-archive", { archived: true });
  const denied = await serveBoarderGoals(request(hostile), env, "boarder-c", headers);
  assert.equal(denied.status, 409);
  assert.deepEqual((await denied.json()).goals, []);
  assert.equal(state.rows.length, 4);
  const reused = { ...creation, operationId: state.rows[3][1], goal: { ...creation.goal, id: state.rows[3][1] } };
  assert.equal((await serveBoarderGoals(request(reused), env, "boarder-a", headers)).status, 409);
  assert.equal(state.rows.length, 4);
  state.rows.push(row({ ...creation, goal: { ...creation.goal, title: "Tampered duplicate" } }));
  await assert.rejects(serveBoarderGoals(request(), env, "boarder-a", headers), /Conflicting saved progress operation/);
  await assert.rejects(serveBoarderProgress(request(), env, "boarder-a", headers), /Conflicting saved progress operation/);
}));

test("both projections fail closed on a corrupt goal timestamp without exposing another owner's row", async () => fixture(async state => {
  state.rows.push(row(create(), "boarder-a", "wrong"));
  await assert.rejects(serveBoarderGoals(request(), env, "boarder-a", headers), /Invalid goal timestamp/);
  await assert.rejects(serveBoarderProgress(request(), env, "boarder-a", headers), /Invalid goal timestamp/);
  assert.equal((await (await serveBoarderGoals(request(), env, "boarder-b", headers)).json()).goals.length, 0);
}));

test("invalid input and cross-site requests never reach Sheets", async () => fixture(async state => {
  const creation = create();
  const invalid = [
    "{", { ...creation, goal: { ...creation.goal, dueDate: "2027-02-30" } },
    { ...creation, goal: { ...creation.goal, dueDate: null } },
    { ...creation, goal: { ...creation.goal, category: "administrator" } },
    { ...creation, goal: { ...creation.goal, id: randomUUID() } },
    { ...creation, goal: { ...creation.goal, milestones: [] } },
    { ...creation, goal: { ...creation.goal, milestones: [creation.goal.milestones[0], creation.goal.milestones[0]] } },
    { ...creation, goal: { ...creation.goal, title: "x".repeat(121) } },
    { ...creation, goal: { ...creation.goal, title: "\u0000hidden" } },
    "x".repeat(8193),
    { operationId: randomUUID(), action: "goal-milestone", goalId: creation.goal.id, previous: creation.operationId,
      milestoneId: creation.goal.milestones[0].id, done: true, evidence: " " }
  ];
  for (const operation of invalid) {
    const response = await serveBoarderGoals(request(operation), env, "boarder-a", headers);
    assert.equal(response.status, 400);
  }
  for (const requestHeaders of [{ Origin: "https://other.example.invalid" }, { "Sec-Fetch-Site": "cross-site" }, { "Content-Type": "text/plain" }]) {
    assert.equal((await serveBoarderGoals(request(creation, requestHeaders), env, "boarder-a", headers)).status, 403);
  }
  assert.equal(state.reads, 0);
  assert.equal(state.rows.length, 1);
}));

test("goal replay rejects corrupt schemas, timestamps and excessive goals", () => {
  const creation = create();
  assert.throws(() => projectGoals([["Wrong headers"]], "boarder-a"), /headers changed/);
  assert.throws(() => projectGoals([columns, row({ operationId: randomUUID(), action: "unexpected" })], "boarder-a"), /Invalid saved progress row/);
  assert.throws(() => projectGoals([columns, row(creation, "boarder-a", "not a timestamp")], "boarder-a"), /Invalid goal timestamp/);
  const rows = [columns, ...Array.from({ length: 51 }, () => row(create()))];
  const result = projectGoals(rows, "boarder-a");
  assert.equal(result.goals.length, 50);
  assert.equal(result.operations.get(rows.at(-1)[1]).applied, false);
  assert.equal(normalizeGoalOperation({ ...creation, goal: { ...creation.goal,
    milestones: Array.from({ length: 11 }, () => ({ id: randomUUID(), title: "A step", criterion: "An observable result" })) } }), null);
});

test("weekly review uses Dubai Monday boundaries and removes reopened completion evidence", () => {
  const creation = create();
  let result = projectGoals([columns, row(creation)], "boarder-a");
  let goal = result.goals[0];
  const one = change(goal, "goal-milestone", { milestoneId: goal.milestones[0].id, done: true, evidence: "Paper checked." });
  const rows = [columns, row(creation), row(one, "boarder-a", "2027-01-10T20:15:00.000Z")];
  result = projectGoals(rows, "boarder-a", new Date("2027-01-10T20:30:00.000Z"));
  assert.equal(result.review.weekStart, "2027-01-11");
  assert.equal(result.review.weekEnd, "2027-01-17");
  assert.equal(result.review.completedMilestones, 1);
  assert.equal(result.review.achievedGoals, 0);
  goal = result.goals[0];
  const two = change(goal, "goal-milestone", { milestoneId: goal.milestones[1].id, done: true, evidence: "Answers explained." });
  rows.push(row(two, "boarder-a", "2027-01-11T06:00:00.000Z"));
  result = projectGoals(rows, "boarder-a", new Date("2027-01-11T07:00:00.000Z"));
  assert.equal(result.goals[0].status, "achieved");
  assert.equal(result.goals[0].nextMilestone, null);
  assert.equal(result.review.achievedGoals, 1);
  assert.equal(weeklyGoalReview(result.goals, new Date("2027-01-10T20:30:00.000Z")).achievedGoals, 0);
  assert.equal(weeklyGoalReview(result.goals, new Date("2027-01-10T19:59:59.000Z")).completedMilestones, 0);
  rows.push(row(change(result.goals[0], "goal-milestone", { milestoneId: goal.milestones[0].id, done: false, evidence: "" }),
    "boarder-a", "2027-01-11T08:00:00.000Z"));
  result = projectGoals(rows, "boarder-a", new Date("2027-01-11T09:00:00.000Z"));
  assert.equal(result.review.completedMilestones, 1);
  assert.equal(result.review.achievedGoals, 0);
});
