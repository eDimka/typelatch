import { calculateInvoiceTotal, validateInvoice, type Invoice } from './billing.js';
import { sessionIsValid, type Session } from './session.js';

// Submit an order only after session authorization and invoice validation.
export function submitOrder(invoice: Invoice, session: Session, now: number): number {
  if (!sessionIsValid(session, now)) throw new Error('Session expired');
  if (!validateInvoice(invoice)) throw new Error('Invalid invoice');
  return calculateInvoiceTotal(invoice);
}
