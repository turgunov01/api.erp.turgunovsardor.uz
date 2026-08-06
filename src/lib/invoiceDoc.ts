// Renders an official "Счёт на оплату" (invoice for payment) as a printable HTML page.
import type { Invoice, Tenant } from '@prisma/client';
import type { SellerRequisites } from './requisites.js';

const money = (minor: number, cur = 'UZS') =>
  (minor / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + cur;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function row(label: string, value: unknown) {
  return `<tr><td class="l">${esc(label)}</td><td class="v">${esc(value) || '—'}</td></tr>`;
}

export function renderInvoiceDoc(invoice: Invoice, tenant: Tenant, seller: SellerRequisites): string {
  const date = new Date(invoice.createdAt).toLocaleDateString('ru-RU');
  const netMinor = invoice.amountMinor - invoice.vatMinor;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<title>Счёт № ${esc(invoice.number)}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;max-width:820px;margin:24px auto;padding:0 20px}
  h1{font-size:22px;margin:0 0 4px} .muted{color:#64748b}
  .box{border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:14px 0}
  table{width:100%;border-collapse:collapse} td{padding:5px 8px;vertical-align:top;font-size:14px}
  td.l{color:#64748b;width:210px} td.v{font-weight:600}
  .items th,.items td{border:1px solid #e2e8f0;padding:9px;font-size:14px;text-align:left}
  .items th{background:#f8fafc}
  .tot{text-align:right;font-size:15px;margin-top:6px} .tot b{font-size:18px}
  .sign{display:flex;gap:40px;margin-top:34px} .sign .s{flex:1;border-top:1px solid #94a3b8;padding-top:6px;color:#64748b;font-size:13px}
  .print{margin:14px 0} button{padding:9px 16px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}
  @media print{.print{display:none}}
</style></head><body>
  <div class="print"><button onclick="window.print()">Печать / Сохранить в PDF</button></div>
  <h1>Счёт на оплату № ${esc(invoice.number)}</h1>
  <div class="muted">от ${esc(date)} · Способ оплаты: банковский перевод по реквизитам</div>

  <div class="box"><b>Поставщик</b>
    <table>
      ${row('Наименование', seller.sellerName)}
      ${row('ИНН', seller.sellerInn)}
      ${row('Адрес', seller.address)}
      ${row('Банк', seller.bank)}
      ${row('Расчётный счёт', seller.account)}
      ${row('МФО', seller.mfo)}
      ${row('Директор', seller.director)}
      ${row('Контакты', [seller.phone, seller.email].filter(Boolean).join(' · '))}
    </table>
  </div>

  <div class="box"><b>Покупатель</b>
    <table>
      ${row('Наименование', tenant.billLegalName || tenant.name)}
      ${row('ИНН', tenant.billInn)}
      ${row('Адрес', tenant.billAddress)}
      ${row('Банк', tenant.billBank)}
      ${row('Расчётный счёт', tenant.billAccount)}
      ${row('МФО', tenant.billMfo)}
      ${row('Директор', tenant.billDirector)}
      ${row('Телефон', tenant.billPhone)}
    </table>
  </div>

  <table class="items">
    <thead><tr><th>№</th><th>Наименование</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead>
    <tbody>
      <tr><td>1</td><td>Подписка TTR ONE — тариф «${esc(invoice.plan)}» (30 дней)</td><td>1</td>
        <td>${money(invoice.amountMinor, invoice.currency)}</td><td>${money(invoice.amountMinor, invoice.currency)}</td></tr>
    </tbody>
  </table>
  <div class="tot">Без НДС: ${money(netMinor, invoice.currency)}</div>
  <div class="tot">НДС (QQS): ${money(invoice.vatMinor, invoice.currency)}</div>
  <div class="tot"><b>Итого к оплате: ${money(invoice.amountMinor, invoice.currency)}</b></div>

  <div class="sign"><div class="s">Руководитель ______________</div><div class="s">Бухгалтер ______________</div></div>
  <p class="muted" style="margin-top:20px;font-size:12px">Оплатите по указанным реквизитам. Доступ активируется после подтверждения поступления оплаты.
  Официальная ЭСФ формируется через Didox после подключения интеграции.</p>
</body></html>`;
}
