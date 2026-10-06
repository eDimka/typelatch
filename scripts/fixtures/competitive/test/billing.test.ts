import { calculateInvoiceTotal } from '../src/billing.js';

export function invoiceRoundingTest(): void {
  const total = calculateInvoiceTotal({ subtotal: 12.34, taxRate: 0.21 });
  if (total !== 14.93) throw new Error('Invoice rounding regression');
}
