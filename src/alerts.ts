// In-app alert feed + outbound adapter (webhook or Telegram).
// The public demo always uses the stub: it records the message it would send and sends nothing.

import { isDemo, type Role } from "./identity";
import { log } from "./http";

export type AlertEvent = "created" | "approved" | "rejected" | "done";
export type AdapterName = "stub" | "webhook" | "telegram";

export interface NewAlert {
  at: number;
  audience: Role;
  ref: number;
  text: string;
  payload: string;
}

export interface OutboundEnv {
  DEMO_MODE: string;
  ALERT_ADAPTER: string;
  ALERT_WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

const AUDIENCES: Record<AlertEvent, Role[]> = {
  created: ["manager"],
  approved: ["staff"],
  rejected: ["staff"],
  done: ["owner", "manager"],
};

export function alertText(event: AlertEvent, ref: number, title: string, by: string): string {
  const r = `R-${ref}`;
  switch (event) {
    case "created":
      return `${r} needs approval: ${title}`;
    case "approved":
      return `${r} approved by ${by}: ${title}`;
    case "rejected":
      return `${r} rejected by ${by}: ${title}`;
    case "done":
      return `${r} done by ${by}: ${title}`;
  }
}

/** The JSON body the webhook adapter POSTs. Telegram receives `text` only. */
export function webhookBody(event: AlertEvent, audience: Role, ref: number, text: string, at: number): string {
  return JSON.stringify({ event: `request.${event}`, audience, ref, text, at: new Date(at).toISOString() });
}

export function buildAlerts(event: AlertEvent, ref: number, title: string, by: string, at: number): NewAlert[] {
  const text = alertText(event, ref, title, by).slice(0, 200);
  return AUDIENCES[event].map((audience) => ({
    at,
    audience,
    ref,
    text,
    payload: webhookBody(event, audience, ref, text, at),
  }));
}

export function adapterName(env: OutboundEnv): AdapterName {
  if (isDemo(env)) return "stub";
  if (env.ALERT_ADAPTER === "webhook" && env.ALERT_WEBHOOK_URL) return "webhook";
  if (env.ALERT_ADAPTER === "telegram" && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) return "telegram";
  return "stub";
}

export function insertAlerts(db: D1Database, sandboxId: string, alerts: NewAlert[], delivery: string): D1PreparedStatement[] {
  return alerts.map((a) =>
    db
      .prepare(
        `INSERT INTO alerts (sandbox_id, at, audience, ref, text, delivery, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
      )
      .bind(sandboxId, a.at, a.audience, a.ref, a.text, delivery, a.payload),
  );
}

/**
 * Sends alerts through the configured adapter. Runs inside ctx.waitUntil after the response.
 * Each delivery outcome is written back to the alert row (sent / failed: <status>).
 */
export async function deliverAlerts(
  env: OutboundEnv & { DB: D1Database },
  sandboxId: string,
  sent: Array<{ id: number; alert: NewAlert }>,
): Promise<void> {
  const adapter = adapterName(env);
  if (adapter === "stub" || sent.length === 0) return;
  const outcomes: Array<{ id: number; delivery: string }> = [];
  for (const { id, alert } of sent) {
    let delivery: string;
    try {
      const res =
        adapter === "webhook"
          ? await fetch(env.ALERT_WEBHOOK_URL!, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: alert.payload,
              signal: AbortSignal.timeout(5000),
            })
          : await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: alert.text }),
              signal: AbortSignal.timeout(5000),
            });
      delivery = res.ok ? `sent:${adapter}` : `failed:${adapter}:${res.status}`;
    } catch (err) {
      delivery = `failed:${adapter}:network`;
      log("warn", "alert_delivery_failed", { adapter, reason: err instanceof Error ? err.name : "unknown" });
    }
    outcomes.push({ id, delivery });
  }
  await env.DB.batch(
    outcomes.map((o) =>
      env.DB.prepare(`UPDATE alerts SET delivery = ?1 WHERE id = ?2 AND sandbox_id = ?3`).bind(o.delivery, o.id, sandboxId),
    ),
  );
}
