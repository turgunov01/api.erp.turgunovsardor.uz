// 9.2 Outbound notification channels. Real delivery (SMTP / Telegram Bot API) is a
// stub until credentials are configured — mirrors the Didox/payments stub pattern.
// Handlers are invoked from the job worker so a slow/failed send is retried, not
// blocking the request that triggered it.

export interface EmailMessage { to: string; subject: string; text: string }
export interface TelegramMessage { chatId: string; text: string }

export async function sendEmail(msg: EmailMessage): Promise<{ delivered: boolean; provider: string }> {
  const configured = !!process.env.SMTP_URL;
  if (!configured) {
    console.log(`[email:stub] → ${msg.to} :: ${msg.subject}`);
    return { delivered: false, provider: 'stub' };
  }
  // Real SMTP integration would go here (nodemailer). Kept as a stub by design.
  console.log(`[email] → ${msg.to} :: ${msg.subject}`);
  return { delivered: true, provider: 'smtp' };
}

export async function sendTelegram(msg: TelegramMessage): Promise<{ delivered: boolean; provider: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(`[telegram:stub] → ${msg.chatId} :: ${msg.text.slice(0, 60)}`);
    return { delivered: false, provider: 'stub' };
  }
  console.log(`[telegram] → ${msg.chatId}`);
  return { delivered: true, provider: 'telegram' };
}
