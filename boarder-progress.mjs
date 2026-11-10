import { plannerSheet, plannerWorkbook, readPlannerJson } from "./personal-calendar.mjs";
import { normalizeProgressOperation, normalizeGoalOperation, validGoalTimestamp } from "./progress-operations.mjs";

const range = "'Boarder Progress'!A1:D";
const headers = ["Student ID", "Operation ID", "Progress JSON", "Saved at"];

function projectProgress(rows, studentId) {
  if (!headers.every((header, index) => rows[0]?.[index] === header)) throw new Error("Progress headers changed");
  const operations = new Map();
  const plans = new Map();
  const earnedStones = new Set();
  const earnedLandmarks = new Set();
  let focusMinutes = 0;
  for (const [owner, operationId, data, savedAt] of rows.slice(1)) {
    if (String(owner) !== studentId) continue;
    const value = { ...JSON.parse(data), operationId };
    const operation = normalizeProgressOperation(value) || normalizeGoalOperation(value);
    if (!operation) throw new Error("Invalid saved progress row");
    if (operation.action.startsWith("goal-") && !validGoalTimestamp(savedAt)) throw new Error("Invalid goal timestamp");
    const canonical = JSON.stringify(operation);
    if (operations.has(operationId)) {
      if (operations.get(operationId) !== canonical) throw new Error("Conflicting saved progress operation");
      continue;
    }
    operations.set(operationId, canonical);
    switch (operation.action) {
      case "create-plan": {
        const { plan } = operation;
        const duplicate = [...plans.values()].some(existing =>
          existing.examDate === plan.examDate && existing.subject.toLowerCase() === plan.subject.toLowerCase());
        if (!duplicate) plans.set(plan.id, plan);
        break;
      }
      case "set-session": {
        const session = plans.get(operation.planId)?.sessions.find(item => item.date === operation.date);
        if (session) session.done = operation.done;
        break;
      }
      case "remove-plan":
        plans.delete(operation.planId);
        break;
      case "collect-stone":
        earnedStones.add(operation.stone);
        break;
      case "finish-focus":
        focusMinutes += operation.minutes;
        if (operation.landmark) earnedLandmarks.add(operation.landmark);
        break;
    }
  }
  return { operations, progress: {
    plans: [...plans.values()],
    stones: [...earnedStones],
    study: { landmarks: [...earnedLandmarks], minutes: focusMinutes }
  } };
}

export async function serveBoarderProgress(request, env, studentId, headers) {
  const reply = (data, status = 200) => Response.json(data, { status, headers });
  const config = plannerWorkbook(env);
  if (!config) return reply({ error: "Progress saving is awaiting school setup." }, 503);
  let operation;
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type")?.split(";")[0].trim();
    if (request.headers.get("Origin") !== new URL(request.url).origin || contentType !== "application/json") {
      return reply({ error: "Open Jarvis to save your progress." }, 403);
    }
    operation = normalizeProgressOperation(await readPlannerJson(request, 8192));
    if (!operation) return reply({ error: "Jarvis couldn’t save this change. Check the details and try again." }, 400);
  }

  const sheet = await plannerSheet(config, "progress", range, studentId, Boolean(operation));
  const load = async () => projectProgress(await sheet.read(), studentId);

  let saved = await load();
  if (operation) {
    const { operationId, ...data } = operation;
    if (!saved.operations.has(operationId)) {
      await sheet.append([studentId, operationId, JSON.stringify(data), new Date().toISOString()]);
      saved = await load();
      if (!saved.operations.has(operationId)) throw new Error("Progress write could not be verified");
    }
    if (saved.operations.get(operationId) !== JSON.stringify(operation)) {
      return reply({ error: "Jarvis couldn’t verify this change.", progress: saved.progress }, 409);
    }
  }
  return reply({ progress: saved.progress });
}
