export type Product = { sku: string; title: string; unitGrams: number; unitCents: number };
export type Catalog = Readonly<Record<string, Product>>;
