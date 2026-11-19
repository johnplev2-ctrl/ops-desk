import { HttpError } from "./http";

/** Input and row caps. The UI mirrors these with maxlength; the server and the schema enforce them. */
export const LIMITS = {
  bodyBytes: 8 * 1024,
  title: 80,
  details: 500,
  location: 60,
  note: 280,
  checklistItems: 12,
  checklistLabel: 80,
  costEuros: 100_000,
  // Per-sandbox row caps (demo mode only).
  requestsPerSandbox: 60,
  auditPerSandbox: 1500,
  alertsPerSandbox: 400,
} as const;

export const KINDS = ["repair", "purchase", "task"] as const;
export type Kind = (typeof KINDS)[number];
export const PHOTOS = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
export type Photo = (typeof PHOTOS)[number];

// Control characters other than tab/newline are rejected outright.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u{2028}\u{2029}]/u;

const LABELS: Record<string, string> = {
  title: "Title",
  details: "Details",
  location: "Location",
  note: "Note",
};

interface TextRule {
  max: number;
  min?: number;
  multiline?: boolean;
}

export function text(body: Record<string, unknown>, field: string, rule: TextRule): string {
  const raw = body[field] ?? "";
  const label = LABELS[field] ?? field;
  if (typeof raw !== "string") throw invalid(field, `${label} must be text.`);
  if (CONTROL.test(raw)) throw invalid(field, `${label} contains control characters.`);
  let value = raw.replace(/\r\n?/g, "\n").trim();
  if (!rule.multiline) value = value.replace(/\s+/g, " ");
  else value = value.replace(/\n{3,}/g, "\n\n");
  const length = [...value].length;
  const min = rule.min ?? 0;
  if (length < min) throw invalid(field, min === 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`);
  if (length > rule.max) throw invalid(field, `${label} can be at most ${rule.max} characters.`);
  return value;
}

export function oneOf<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = body[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw invalid(field, `${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function checklist(body: Record<string, unknown>): string[] {
  const raw = body.checklist;
  if (!Array.isArray(raw)) throw invalid("checklist", "checklist must be a list.");
  if (raw.length > LIMITS.checklistItems) {
    throw invalid("checklist", `A checklist can have at most ${LIMITS.checklistItems} items.`);
  }
  const items = raw
    .map((item, i) => {
      if (typeof item !== "string") throw invalid("checklist", `Checklist item ${i + 1} must be text.`);
      if (CONTROL.test(item)) throw invalid("checklist", `Checklist item ${i + 1} contains control characters.`);
      const value = item.trim().replace(/\s+/g, " ");
      if ([...value].length > LIMITS.checklistLabel) {
        throw invalid("checklist", `Checklist item ${i + 1} can be at most ${LIMITS.checklistLabel} characters.`);
      }
      return value;
    })
    .filter((s) => s.length > 0);
  if (items.length === 0) throw invalid("checklist", "Add at least one checklist item.");
  return items;
}

/** Euros as a string or number, up to 2 decimals. Empty means "no estimate". */
export function costCents(body: Record<string, unknown>): number | null {
  const raw = body.cost;
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim().replace(",", ".");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) throw invalid("cost", "cost must be a number of euros, e.g. 38.50.");
  const cents = Math.round(Number(s) * 100);
  if (cents > LIMITS.costEuros * 100) throw invalid("cost", `cost can be at most €${LIMITS.costEuros.toLocaleString("en")}.`);
  return cents;
}

/** A YYYY-MM-DD due date, read as the end of that day in the caller's time zone. */
export function dueAt(body: Record<string, unknown>, tzOffsetMinutes: number, now: number): number {
  const raw = body.dueDate;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw invalid("dueDate", "dueDate must be a date (YYYY-MM-DD).");
  }
  const [y, m, d] = raw.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d, 23, 59, 0);
  const check = new Date(base);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw invalid("dueDate", "dueDate is not a real date.");
  }
  const at = base + tzOffsetMinutes * 60_000;
  const day = 86_400_000;
  if (at < now - day) throw invalid("dueDate", "dueDate cannot be in the past.");
  if (at > now + 366 * day) throw invalid("dueDate", "dueDate must be within a year.");
  return at;
}

/** Minutes to add to local time to get UTC, as returned by Date#getTimezoneOffset. */
export function tzOffset(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < -840 || n > 840) return 0;
  return n;
}

export function invalid(field: string, message: string): HttpError {
  return new HttpError(400, "invalid_input", message, field);
}
