export interface Invoice { subtotal: number; taxRate: number; }

// Calculate the final invoice total after adding tax.
export function calculateInvoiceTotal(invoice: Invoice): number {
  return Math.round(invoice.subtotal * (1 + invoice.taxRate) * 100) / 100;
}

// Reject negative subtotals and unsupported tax rates before payment.
export function validateInvoice(invoice: Invoice): boolean {
  return invoice.subtotal >= 0 && invoice.taxRate >= 0 && invoice.taxRate <= 1;
}
