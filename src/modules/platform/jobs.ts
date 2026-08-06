// 9.1/9.2 Job handlers for the platform module. Registered once at startup.
import { registerJob } from '../../lib/jobs.js';
import { sendEmail, sendTelegram } from '../../lib/channels.js';
import { refreshTenders } from '../../lib/tenders.js';

export function registerPlatformJobs(): void {
  registerJob('email.send', async (p: { to: string; subject: string; text: string }) => {
    return sendEmail(p);
  });
  registerJob('telegram.send', async (p: { chatId: string; text: string }) => {
    return sendTelegram(p);
  });
  // Refresh parsed tenders for a tenant (can be enqueued on a schedule).
  registerJob('tenders.refresh', async (p: { tenantId?: string }, ctx) => {
    const tenantId = p.tenantId ?? ctx.tenantId;
    if (!tenantId) return { skipped: true };
    return refreshTenders(tenantId);
  });
}
