import { dateCell } from "./google-sheets.mjs";

const stones = new Set(["emotions", "relationships", "identity", "resilience", "careers", "independence", "health", "digital", "character", "belonging"]);
const landmarks = new Set(["burj", "frame", "sail", "museum", "wheel", "atlantis", "emirates", "cayan"]);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const date = value => typeof value === "string" ? dateCell(value) : "";
const text = (value, max) => typeof value === "string" && value.length <= max ? value.trim() : "";
const minutes = value => Number.isInteger(value) && value >= 1 && value <= 90;

function normalizePlan(value) {
  const subject = text(value?.subject, 60);
  const examDate = date(value?.examDate);
  const sessions = value?.sessions;
  if (!subject || !examDate || !uuid(value.id) || !Array.isArray(sessions) || !sessions.length || sessions.length > 8) return null;
  const days = new Set();
  const result = [];
  for (const session of sessions) {
    const day = date(session?.date);
    const title = text(session?.title, 60);
    const detail = text(session?.detail, 300);
    if (!day || day > examDate || days.has(day) || !title || !detail || !minutes(session.minutes)) return null;
    days.add(day);
    result.push({ date: day, title, minutes: session.minutes, detail, done: false });
  }
  return { id: value.id, subject, examDate, sessions: result };
}

export function normalizeProgressOperation(value) {
  if (!uuid(value?.operationId)) return null;
  const { operationId, action } = value;
  switch (action) {
    case "create-plan": {
      const plan = normalizePlan(value.plan);
      return plan && plan.id === operationId ? { operationId, action, plan } : null;
    }
    case "set-session":
      return uuid(value.planId) && date(value.date) && typeof value.done === "boolean"
        ? { operationId, action, planId: value.planId, date: value.date, done: value.done } : null;
    case "remove-plan":
      return uuid(value.planId) ? { operationId, action, planId: value.planId } : null;
    case "collect-stone":
      return stones.has(value.stone) ? { operationId, action, stone: value.stone } : null;
    case "finish-focus":
      return minutes(value.minutes) && (value.landmark === "" || landmarks.has(value.landmark))
        ? { operationId, action, minutes: value.minutes, landmark: value.landmark } : null;
    default:
      return null;
  }
}

export const GOAL_CATEGORIES = ["academics", "wellbeing", "sport", "independence", "community", "other"];
export const MAX_GOALS = 50;
export const validGoalTimestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const goalText = (value, maximum) => typeof value === "string" && value.length <= maximum &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ? value.trim() : null;
const goalDate = value => value === "" || (typeof value === "string" && date(value) === value);

function goalFields(value) {
  const title = goalText(value?.title, 120);
  if (!title || !GOAL_CATEGORIES.includes(value.category) || !goalDate(value.dueDate)) return null;
  return { title, category: value.category, dueDate: value.dueDate };
}

export function normalizeGoalOperation(value) {
  if (!uuid(value?.operationId)) return null;
  const { operationId, action } = value;
  if (action === "goal-create") {
    const fields = goalFields(value.goal);
    const source = value.goal?.milestones;
    if (!fields || value.goal.id !== operationId || !Array.isArray(source) || !source.length || source.length > 10) return null;
    const ids = new Set();
    const milestones = [];
    for (const item of source) {
      const title = goalText(item?.title, 120);
      const criterion = goalText(item?.criterion, 240);
      if (!uuid(item?.id) || ids.has(item.id) || !title || !criterion) return null;
      ids.add(item.id);
      milestones.push({ id: item.id, title, criterion });
    }
    return { operationId, action, goal: { id: operationId, ...fields, milestones } };
  }
  if (!uuid(value.goalId) || !uuid(value.previous)) return null;
  const base = { operationId, action, goalId: value.goalId, previous: value.previous };
  if (action === "goal-edit") {
    const fields = goalFields(value.changes);
    return fields ? { ...base, changes: fields } : null;
  }
  if (action === "goal-milestone") {
    const evidence = goalText(value.evidence === undefined ? "" : value.evidence, 500);
    if (!uuid(value.milestoneId) || typeof value.done !== "boolean" || evidence === null ||
        (value.done && !evidence) || (!value.done && evidence)) return null;
    return { ...base, milestoneId: value.milestoneId, done: value.done, evidence };
  }
  if (action === "goal-archive" && typeof value.archived === "boolean") return { ...base, archived: value.archived };
  return null;
}

