export type CartLine = { sku: string; quantity: number };
export type Cart = { lines: readonly CartLine[]; region: string };
