// The demo template: a generic neighbourhood café. Every name and number here is invented demo data.
// Times are relative to the moment a sandbox is created, so overdue and "this week" always make sense.

import { buildAlerts, type NewAlert } from "./alerts";
import { extendChain, insertAudit, type AuditFields } from "./audit";
import type { Role } from "./identity";
import type { Kind, Photo } from "./validate";

export const TEMPLATE_ID = "corner-cafe-v1";
export const WORKSPACE_NAME = "Corner Café";

const H = 3_600_000;

interface Person {
  name: string;
  role: Role;
}
const SAM: Person = { name: "Sam", role: "staff" };
const RIYA: Person = { name: "Riya", role: "staff" };
const ALEX: Person = { name: "Alex", role: "manager" };
const JORDAN: Person = { name: "Jordan", role: "owner" };

interface TplRequest {
  ref: number;
  kind: Kind;
  title: string;
  details: string;
  location: string;
  costCents: number | null;
  createdAgoH: number;
  by: Person;
  dueInH: number;
  decision?: { agoH: number; by: Person; approve: boolean; note: string };
  checklist: Array<{ label: string; doneAgoH?: number; by?: Person }>;
  completion?: { agoH: number; by: Person; photo: Photo };
}

export const PHOTO_CAPTIONS: Record<Photo, string> = {
  p1: "Tap after the repair",
  p2: "Delivery checked in",
  p3: "New light fitted",
  p4: "Machine after cleaning",
  p5: "Paper rolls stocked",
  p6: "Table fixed and level",
};

const TEMPLATE: TplRequest[] = [
  {
    ref: 101, kind: "repair", title: "Fix the dripping tap at the back sink",
    details: "Drips about once a second, all day.", location: "Kitchen", costCents: 6000,
    createdAgoH: 26, by: SAM, dueInH: 46,
    checklist: [
      { label: "Shut off the water under the sink" },
      { label: "Replace the washer" },
      { label: "Run the tap for 2 minutes and check for drips" },
    ],
  },
  {
    ref: 102, kind: "purchase", title: "Order 25 kg of bread flour",
    details: "Down to one sack. Usual supplier, usual grade.", location: "Storeroom", costCents: 3850,
    createdAgoH: 3, by: RIYA, dueInH: 30,
    checklist: [
      { label: "Get this week's price from the supplier" },
      { label: "Place the order" },
      { label: "Check the delivery against the invoice" },
    ],
  },
  {
    ref: 103, kind: "repair", title: "Replace the flickering light in the storeroom",
    details: "The tube flickers; labels on the top shelf are hard to read.", location: "Storeroom", costCents: 2500,
    createdAgoH: 96, by: SAM, dueInH: -20,
    checklist: [
      { label: "Switch off the breaker" },
      { label: "Fit a new LED tube" },
      { label: "Test the switch" },
    ],
  },
  {
    ref: 104, kind: "task", title: "Deep-clean the espresso machine",
    details: "Group heads and steam wand. Descaler is in the blue box.", location: "Front counter", costCents: null,
    createdAgoH: 50, by: ALEX, dueInH: 20,
    decision: { agoH: 30, by: ALEX, approve: true, note: "Do it after close on Thursday." },
    checklist: [
      { label: "Backflush the group heads", doneAgoH: 5, by: SAM },
      { label: "Soak the portafilters", doneAgoH: 4, by: SAM },
      { label: "Purge and wipe the steam wand" },
      { label: "Log it on the cleaning sheet" },
    ],
  },
  {
    ref: 105, kind: "task", title: "Fridge temperature log for the week",
    details: "Two readings a day: morning and close.", location: "Kitchen", costCents: null,
    createdAgoH: 168, by: ALEX, dueInH: -6,
    decision: { agoH: 160, by: ALEX, approve: true, note: "" },
    checklist: [
      { label: "Morning readings, Monday to Sunday" },
      { label: "Closing readings, Monday to Sunday" },
      { label: "Sign the sheet" },
    ],
  },
  {
    ref: 106, kind: "purchase", title: "Receipt printer paper, 20 rolls",
    details: "80 mm thermal rolls.", location: "Front counter", costCents: 2400,
    createdAgoH: 30, by: RIYA, dueInH: 50,
    decision: { agoH: 28, by: ALEX, approve: true, note: "Fine. Same supplier as last time." },
    checklist: [
      { label: "Order the rolls", doneAgoH: 27, by: RIYA },
      { label: "Stock them under the till", doneAgoH: 5, by: RIYA },
    ],
    completion: { agoH: 5, by: RIYA, photo: "p5" },
  },
  {
    ref: 107, kind: "repair", title: "Fix the wobbly table by the window",
    details: "Table 4 rocks when anyone leans on it.", location: "Dining room", costCents: null,
    createdAgoH: 290, by: SAM, dueInH: -200,
    decision: { agoH: 280, by: ALEX, approve: true, note: "" },
    checklist: [
      { label: "Tighten the leg bolts", doneAgoH: 242, by: SAM },
      { label: "Add a felt pad to the short leg", doneAgoH: 241, by: SAM },
    ],
    completion: { agoH: 240, by: SAM, photo: "p6" },
  },
  {
    ref: 108, kind: "purchase", title: "New coffee grinder",
    details: "The current grinder is loud and grinds unevenly.", location: "Front counter", costCents: 89000,
    createdAgoH: 72, by: SAM, dueInH: 240,
    decision: { agoH: 48, by: JORDAN, approve: false, note: "Not this quarter. Get the current one serviced first." },
    checklist: [
      { label: "Get two quotes" },
      { label: "Compare warranty terms" },
    ],
  },
];

// Alerts older than this are shown as already read.
const READ_AFTER_H = 20;

export async function seedStatements(db: D1Database, sandboxId: string, now: number): Promise<D1PreparedStatement[]> {
  const stmts: D1PreparedStatement[] = [];
  const events: AuditFields[] = [];
  const alerts: Array<NewAlert & { read: boolean }> = [];
  const at = (agoH: number) => Math.round(now - agoH * H);

  stmts.push(db.prepare(`INSERT INTO sandboxes (id, created_at, template) VALUES (?1, ?2, ?3)`).bind(sandboxId, now, TEMPLATE_ID));

  for (const t of TEMPLATE) {
    const status = t.completion ? "done" : t.decision ? (t.decision.approve ? "approved" : "rejected") : "pending";
    stmts.push(
      db
        .prepare(
          `INSERT INTO requests (sandbox_id, ref, kind, title, details, location, cost_cents, due_at, status,
             created_at, created_by, decided_at, decided_by, decision_note, completed_at, completed_by, proof_photo)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
        )
        .bind(
          sandboxId, t.ref, t.kind, t.title, t.details, t.location, t.costCents, Math.round(now + t.dueInH * H), status,
          at(t.createdAgoH), t.by.name,
          t.decision ? at(t.decision.agoH) : null, t.decision?.by.name ?? null, t.decision ? t.decision.note : null,
          t.completion ? at(t.completion.agoH) : null, t.completion?.by.name ?? null, t.completion?.photo ?? null,
        ),
    );
    t.checklist.forEach((item, i) => {
      stmts.push(
        db
          .prepare(`INSERT INTO checklist_items (sandbox_id, ref, pos, label, done_at, done_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
          .bind(sandboxId, t.ref, i + 1, item.label, item.doneAgoH !== undefined ? at(item.doneAgoH) : null, item.by?.name ?? null),
      );
    });

    events.push({
      at: at(t.createdAgoH), actor: t.by.name, role: t.by.role, action: "request.created", ref: t.ref,
      detail: `Filed ${t.kind} request "${t.title}" with ${t.checklist.length} checklist ${t.checklist.length === 1 ? "item" : "items"}`,
    });
    alerts.push(...buildAlerts("created", t.ref, t.title, t.by.name, at(t.createdAgoH)).map((a) => ({ ...a, read: t.createdAgoH > READ_AFTER_H || t.decision !== undefined })));
    if (t.decision) {
      const d = t.decision;
      events.push({
        at: at(d.agoH), actor: d.by.name, role: d.by.role, action: d.approve ? "request.approved" : "request.rejected", ref: t.ref,
        detail: d.note ? `${d.approve ? "Approved" : "Rejected"} with note "${d.note}"` : d.approve ? "Approved" : "Rejected",
      });
      alerts.push(...buildAlerts(d.approve ? "approved" : "rejected", t.ref, t.title, d.by.name, at(d.agoH)).map((a) => ({ ...a, read: d.agoH > READ_AFTER_H })));
    }
    for (const item of t.checklist) {
      if (item.doneAgoH === undefined || !item.by) continue;
      events.push({ at: at(item.doneAgoH), actor: item.by.name, role: item.by.role, action: "checklist.ticked", ref: t.ref, detail: `Ticked "${item.label}"` });
    }
    if (t.completion) {
      const c = t.completion;
      events.push({
        at: at(c.agoH), actor: c.by.name, role: c.by.role, action: "request.completed", ref: t.ref,
        detail: `Marked done with proof photo ${c.photo} (${PHOTO_CAPTIONS[c.photo]})`,
      });
      alerts.push(...buildAlerts("done", t.ref, t.title, c.by.name, at(c.agoH)).map((a) => ({ ...a, read: c.agoH > READ_AFTER_H })));
    }
  }

  events.sort((a, b) => a.at - b.at);
  events.push({
    at: now, actor: "Ops desk", role: "system", action: "sandbox.seeded", ref: null,
    detail: `Loaded demo data from template ${TEMPLATE_ID}. Entries before this one are generated sample history.`,
  });
  const entries = await extendChain(null, events);
  stmts.push(...insertAudit(db, sandboxId, entries));

  alerts.sort((a, b) => a.at - b.at);
  for (const a of alerts) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO alerts (sandbox_id, at, audience, ref, text, read_at, delivery, payload)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'stub', ?7)`,
        )
        .bind(sandboxId, a.at, a.audience, a.ref, a.text, a.read ? a.at : null, a.payload),
    );
  }
  return stmts;
}
