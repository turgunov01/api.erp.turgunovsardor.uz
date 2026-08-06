// Didox (didox.uz) e-invoicing integration — creates an official ЭСФ (электронный
// счёт-фактура) for an invoice. This is a STUB: real integration needs Didox API
// credentials (DIDOX_API_KEY / DIDOX_TOKEN) and their document schema. Wire later.
export function isDidoxConfigured(): boolean {
  return Boolean(process.env.DIDOX_API_KEY && process.env.DIDOX_TOKEN);
}

export interface DidoxResult {
  didoxId: string;
  status: string;
}

export async function createEsf(_params: {
  invoiceNumber: string;
  amountMinor: number;
  vatMinor: number;
  buyerInn: string;
  buyerName: string;
}): Promise<DidoxResult> {
  if (!isDidoxConfigured()) {
    throw new Error('Интеграция с Didox не настроена. Добавьте DIDOX_API_KEY и DIDOX_TOKEN, чтобы формировать официальную ЭСФ.');
  }
  // TODO: POST to Didox API, map response. Placeholder for the wired implementation.
  throw new Error('Didox: реальная отправка ЭСФ будет реализована после подключения API.');
}
