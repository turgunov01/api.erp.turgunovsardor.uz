// Payment provider abstraction.
// SANDBOX ONLY: the default "mock" provider simulates a successful charge and moves
// NO real money. Real providers (Payme / Click / Stripe) are stubbed and require
// credentials + server-to-server integration to be wired in a later stage.
import crypto from 'node:crypto';

// Online card providers. "card" is the built-in sandbox (no real money).
export type CardProvider = 'card' | 'mock' | 'payme' | 'click' | 'stripe';

export interface ChargeResult {
  status: 'succeeded' | 'failed';
  providerRef: string;
}

export async function charge(params: { amountMinor: number; currency: string; method: CardProvider; description: string }): Promise<ChargeResult> {
  if (params.method === 'card' || params.method === 'mock') {
    // SANDBOX: simulate a successful card charge. No real money moves.
    return { status: 'succeeded', providerRef: 'sandbox_' + crypto.randomBytes(8).toString('hex') };
  }
  // Real card providers require credentials + server-to-server integration (wired later).
  throw new Error(`Провайдер карт "${params.method}" ещё не подключён (нужны ключи). Используйте оплату по реквизитам или тестовую карту.`);
}
