import { plannerSheet, plannerWorkbook, readPlannerJson } from "./personal-calendar.mjs";
import { MAX_GOALS, normalizeGoalOperation, normalizeProgressOperation, validGoalTimestamp } from "./progress-operations.mjs";

const range = "'Boarder Progress'!A1:D";
const columns = ["Student ID", "Operation ID", "Progress JSON", "Saved at"];
const dayMs = 86_400_000;

function canApply(goals, operation) {
  if (operation.action === "goal-create") return !goals.has(operation.goal.id) && goals.size < MAX_GOALS;
  const goal = goals.get(operation.goalId);
  if (!goal || goal.revision !== operation.previous) return false;
  if (operation.action === "goal-archive") return goal.archived !== operation.archived;
  if (goal.archived) return false;
  if (operation.action === "goal-milestone") {
    const milestone = goal.milestones.find(item => item.id === operation.milestoneId);
    return Boolean(milestone && milestone.done !== operation.done);
  }
  return operation.action === "goal-edit";
}

function apply(goals, operation, at) {
  if (operation.action === "goal-create") {
    goals.set(operation.goal.id, {
      ...operation.goal, revision: operation.operationId, archived: false, createdAt: at, updatedAt: at,
      milestones: operation.goal.milestones.map(item => ({ ...item, done: false, evidence: "", completedAt: null }))
    });
    return;
  }
  const goal = goals.get(operation.goalId);
  if (operation.action === "goal-edit") Object.assign(goal, operation.changes);
  if (operation.action === "goal-archive") goal.archived = operation.archived;
  if (operation.action === "goal-milestone") {
    const milestone = goal.milestones.find(item => item.id === operation.milestoneId);
    Object.assign(milestone, { done: operation.done, evidence: operation.evidence,
      completedAt: operation.done ? at : null });
  }
  goal.revision = operation.operationId;
  goal.updatedAt = at;
}

function serialize(goal) {
  const done = goal.milestones.filter(item => item.done).length;
  return { ...goal, percent: Math.round(done * 100 / goal.milestones.length),
    status: goal.archived ? "archived" : done === goal.milestones.length ? "achieved" : "active",
    nextMilestone: goal.milestones.find(item => !item.done) || null };
}

function dubaiDate(value) {
  return new Date(new Date(value).getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function weeklyGoalReview(goals, now = new Date()) {
  const today = dubaiDate(now);
  const utc = new Date(today + "T00:00:00Z");
  const monday = new Date(utc.getTime() - ((utc.getUTCDay() + 6) % 7) * dayMs);
  const weekStart = monday.toISOString().slice(0, 10);
  const weekEnd = new Date(monday.getTime() + 6 * dayMs).toISOString().slice(0, 10);
  const entries = [];
  const achieved = new Set();
  for (const goal of goals) {
    for (const milestone of goal.milestones) {
      if (!milestone.done || !milestone.completedAt) continue;
      const date = dubaiDate(milestone.completedAt);
      if (date < weekStart || date > weekEnd || new Date(milestone.completedAt) > now) continue;
      entries.push({ goalId: goal.id, goalTitle: goal.title, milestoneId: milestone.id,
        title: milestone.title, evidence: milestone.evidence, completedAt: milestone.completedAt, date });
      if (goal.milestones.every(item => item.done && item.completedAt && new Date(item.completedAt) <= now)) achieved.add(goal.id);
    }
  }
  entries.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.milestoneId.localeCompare(b.milestoneId));
  return { weekStart, weekEnd, completedMilestones: entries.length, achievedGoals: achieved.size, entries };
}

export function projectGoals(rows, studentId, now = new Date()) {
  if (!columns.every((header, index) => rows[0]?.[index] === header)) throw new Error("Progress headers changed");
  const goals = new Map();
  const operations = new Map();
  for (const [owner, operationId, data, savedAt] of rows.slice(1)) {
    if (String(owner) !== studentId) continue;
    const value = { ...JSON.parse(data), operationId };
    const goalOperation = normalizeGoalOperation(value);
    const operation = goalOperation || normalizeProgressOperation(value);
    if (!operation) throw new Error("Invalid saved progress row");
    if (goalOperation && !validGoalTimestamp(savedAt)) throw new Error("Invalid goal timestamp");
    const canonical = JSON.stringify(operation);
    if (operations.has(operationId)) {
      if (operations.get(operationId).canonical !== canonical) throw new Error("Conflicting saved progress operation");
      continue;
    }
    const applied = Boolean(goalOperation && canApply(goals, operation));
    operations.set(operationId, { canonical, applied });
    if (applied) apply(goals, operation, savedAt);
  }
  const list = [...goals.values()].map(serialize).sort((a, b) => Number(a.archived) - Number(b.archived) ||
    (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { state: goals, operations, goals: list, review: weeklyGoalReview(list, now) };
}

export async function serveBoarderGoals(request, env, studentId, responseHeaders) {
  const reply = (value, status = 200) => Response.json(value, { status, headers: responseHeaders });
  if (!["GET", "POST"].includes(request.method)) return reply({ error: "Method not allowed." }, 405);
  const config = plannerWorkbook(env);
  if (!config) return reply({ error: "Goals saving is awaiting school setup." }, 503);
  let operation;
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type")?.split(";")[0].trim();
    if (request.headers.get("Origin") !== new URL(request.url).origin || contentType !== "application/json" ||
        request.headers.get("Sec-Fetch-Site") === "cross-site") {
      return reply({ error: "Open Jarvis to save your goals." }, 403);
    }
    operation = normalizeGoalOperation(await readPlannerJson(request, 8192));
    if (!operation) return reply({ error: "Check your goal details. Each completed milestone needs evidence." }, 400);
  }
  const sheet = await plannerSheet(config, "progress", range, studentId, Boolean(operation));
  const load = async () => projectGoals(await sheet.read(), studentId);
  let saved = await load();
  if (operation) {
    const { operationId, ...data } = operation;
    if (!saved.operations.has(operationId) && canApply(saved.state, operation)) {
      await sheet.append([studentId, operationId, JSON.stringify(data), new Date().toISOString()]);
      saved = await load();
      if (!saved.operations.has(operationId)) throw new Error("Goal write could not be verified");
    }
    const recorded = saved.operations.get(operationId);
    if (!recorded?.applied || recorded.canonical !== JSON.stringify(operation)) {
      return reply({ error: saved.state.size >= MAX_GOALS && operation.action === "goal-create"
        ? "You have reached the limit of 50 saved goals. Edit or restore an existing goal."
        : "This goal has changed. Review the latest version and try again.", goals: saved.goals, review: saved.review }, 409);
    }
  }
  return reply({ goals: saved.goals, review: saved.review });
}
