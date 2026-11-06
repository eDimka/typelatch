import type { Catalog, Product } from "./types.js";

export type CatalogRow = {
  sku: string;
  title: string;
  unitGrams: number;
  unitCents: number;
  tags: readonly string[];
  active: boolean;
};
export type CatalogIssue = { row: number; field: string; message: string };
export type CatalogImport = { rows: CatalogRow[]; issues: CatalogIssue[] };
export type CatalogFilter = {
  query?: string;
  tags?: readonly string[];
  minCents?: number;
  maxCents?: number;
  includeInactive?: boolean;
};
export type CatalogPage = { rows: CatalogRow[]; total: number; nextOffset: number | null };
export type CatalogChange =
  | { kind: "upsert"; row: CatalogRow }
  | { kind: "deactivate"; sku: string }
  | { kind: "remove"; sku: string };
export type CatalogRevision = { revision: number; rows: CatalogRow[]; changedSkus: string[] };

export function copyCatalog(catalog: Catalog): Catalog {
  return Object.fromEntries(Object.entries(catalog).map(([sku, product]) => [sku, { ...product }]));
}

function copyRow(row: CatalogRow): CatalogRow {
  return { ...row, tags: [...row.tags] };
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== "string")) return null;
  return [...new Set(value.map(tag => (tag as string).trim().toLowerCase()).filter(Boolean))].sort();
}

export function readCatalogRows(input: unknown): CatalogImport {
  if (!Array.isArray(input)) return { rows: [], issues: [{ row: 0, field: "rows", message: "Expected an array" }] };
  const rows: CatalogRow[] = [];
  const issues: CatalogIssue[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of input.entries()) {
    const row = index + 1;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      issues.push({ row, field: "row", message: "Expected a record" });
      continue;
    }
    const value = candidate as Record<string, unknown>;
    const start = issues.length;
    const sku = typeof value.sku === "string" ? value.sku.trim() : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const tags = normalizeTags(value.tags ?? []);
    if (!sku) issues.push({ row, field: "sku", message: "SKU is required" });
    else if (seen.has(sku)) issues.push({ row, field: "sku", message: "Duplicate SKU" });
    if (!title) issues.push({ row, field: "title", message: "Title is required" });
    if (!validInteger(value.unitGrams)) issues.push({ row, field: "unitGrams", message: "Expected nonnegative integer grams" });
    if (!validInteger(value.unitCents)) issues.push({ row, field: "unitCents", message: "Expected nonnegative integer cents" });
    if (tags === null) issues.push({ row, field: "tags", message: "Expected string tags" });
    if (value.active !== undefined && typeof value.active !== "boolean") issues.push({ row, field: "active", message: "Expected boolean" });
    if (issues.length !== start) continue;
    seen.add(sku);
    rows.push({ sku, title, unitGrams: value.unitGrams as number, unitCents: value.unitCents as number, tags: tags ?? [], active: value.active !== false });
  }
  return { rows, issues };
}

function matches(row: CatalogRow, filter: CatalogFilter): boolean {
  if (!filter.includeInactive && !row.active) return false;
  if (filter.minCents !== undefined && row.unitCents < filter.minCents) return false;
  if (filter.maxCents !== undefined && row.unitCents > filter.maxCents) return false;
  const terms = (filter.query ?? "").trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const searchable = `${row.sku} ${row.title} ${row.tags.join(" ")}`.toLowerCase();
  if (terms.some(term => !searchable.includes(term))) return false;
  const requiredTags = filter.tags ?? [];
  return requiredTags.every(tag => row.tags.includes(tag.trim().toLowerCase()));
}

export function catalogToProducts(rows: readonly CatalogRow[]): Catalog {
  const products: Record<string, Product> = Object.create(null) as Record<string, Product>;
  for (const row of rows) {
    if (!row.active) continue;
    products[row.sku] = { sku: row.sku, title: row.title, unitGrams: row.unitGrams, unitCents: row.unitCents };
  }
  return products;
}

export class CatalogStore {
  private rows = new Map<string, CatalogRow>();
  private revision = 0;
  private readonly history: CatalogRevision[] = [];

  constructor(initial: readonly CatalogRow[] = []) {
    const parsed = readCatalogRows(initial);
    if (parsed.issues.length) throw new Error("Invalid initial catalog");
    for (const row of parsed.rows) this.rows.set(row.sku, copyRow(row));
  }

  get(sku: string): CatalogRow | null {
    const row = this.rows.get(sku);
    return row ? copyRow(row) : null;
  }

  search(filter: CatalogFilter = {}, offset = 0, limit = 20): CatalogPage {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid catalog offset");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid catalog limit");
    const selected = [...this.rows.values()].filter(row => matches(row, filter));
    selected.sort((left, right) => left.title.localeCompare(right.title) || left.sku.localeCompare(right.sku));
    const rows = selected.slice(offset, offset + limit).map(copyRow);
    const nextOffset = offset + rows.length < selected.length ? offset + rows.length : null;
    return { rows, total: selected.length, nextOffset };
  }

  apply(changes: readonly CatalogChange[]): CatalogRevision {
    const next = new Map([...this.rows.entries()].map(([key, row]) => [key, copyRow(row)]));
    const changed = new Set<string>();
    for (const change of changes) {
      if (change.kind === "upsert") {
        const parsed = readCatalogRows([change.row]);
        const row = parsed.rows[0];
        if (parsed.issues.length || !row) throw new Error("Invalid catalog change");
        next.set(row.sku, copyRow(row));
        changed.add(row.sku);
      } else if (change.kind === "deactivate") {
        const row = next.get(change.sku);
        if (!row) throw new Error(`Unknown catalog SKU: ${change.sku}`);
        next.set(row.sku, { ...row, active: false });
        changed.add(row.sku);
      } else if (next.delete(change.sku)) {
        changed.add(change.sku);
      }
    }
    this.rows = next;
    this.revision += 1;
    const revision = { revision: this.revision, rows: [...next.values()].map(copyRow), changedSkus: [...changed].sort() };
    this.history.push(revision);
    return { ...revision, rows: revision.rows.map(copyRow), changedSkus: [...revision.changedSkus] };
  }

  changesAfter(revision: number): CatalogRevision[] {
    return this.history.filter(item => item.revision > revision).map(item => ({ ...item, rows: item.rows.map(copyRow), changedSkus: [...item.changedSkus] }));
  }

  products(): Catalog {
    return catalogToProducts([...this.rows.values()]);
  }

  totals(): { active: number; inactive: number; catalogValueCents: number; tags: string[] } {
    const rows = [...this.rows.values()];
    return {
      active: rows.filter(row => row.active).length,
      inactive: rows.filter(row => !row.active).length,
      catalogValueCents: rows.filter(row => row.active).reduce((total, row) => total + row.unitCents, 0),
      tags: [...new Set(rows.flatMap(row => row.tags))].sort(),
    };
  }
}
