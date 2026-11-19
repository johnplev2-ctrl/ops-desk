// Optional secrets for the real outbound adapters (production only).
// Set them with `npx wrangler pages secret put <NAME> --project-name <project>`; never commit values.
interface Env {
  ALERT_WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}
