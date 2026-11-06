import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { analyzeFile, buildBrain } from "../src/indexer.js"
import { packPackage, resolvePackage } from "../src/npm.js"
import { getSymbol } from "../src/query.js"
import type { BrainFormat } from "../src/types.js"

vi.mock("../src/npm.js", () => ({ resolvePackage: vi.fn(), packPackage: vi.fn() }))

async function signatures(text: string): Promise<Map<string, string>> {
  const root = mkdtempSync(join(tmpdir(), "typelatch-callable-"))
  try {
    const file = join(root, "api.ts")
    writeFileSync(file, text)
    const result = await analyzeFile(file, root, root, new Set(), "fixture", "source")
    return new Map(result.symbols.map(symbol => [symbol.name, symbol.signature]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("source callable variable declarations", () => {
  it("retains declared generic parameters, arguments and return type without the arrow body", async () => {
    const result = await signatures(`
export const NonEmptyArray = <Value extends Schema.Any>(value: Value): NonEmptyArray<Value> =>
  makeNonEmptyArrayClass(value) as any
`)
    expect(result.get("NonEmptyArray")).toBe("export const NonEmptyArray = <Value extends Schema.Any>(value: Value): NonEmptyArray<Value> => …")
  })

  it("retains async, optional, default and rest parameter syntax without inventing a return type", async () => {
    const result = await signatures(`
export const decode = async (input: string, retries = 2, label?: string, ...flags: boolean[]) => {
  const privateImplementation = input.trim()
  return privateImplementation
}
`)
    expect(result.get("decode")).toBe("export const decode = async (input: string, retries = 2, label?: string, ...flags: boolean[]) => …")
  })

  it("retains parenthesized arrow and named generator expression headers", async () => {
    const result = await signatures(`
export const convert = ((value: string): number => Number(value))
export const values = async function* iterate<T>(input: readonly T[]): AsyncGenerator<T> {
  yield* input
}
`)
    expect(result.get("convert")).toBe("export const convert = (value: string): number => …")
    expect(result.get("values")).toBe("export const values = async function* iterate<T>(input: readonly T[]): AsyncGenerator<T> …")
  })

  it("keeps an explicit variable type authoritative and does not guess factory or alias callability", async () => {
    const result = await signatures(`
export const explicit: <A>(value: A) => A = value => value
export const asserted = ((value: string) => value) as Callable
export const factory = makeCallable()
export const alias = factory
export const object = { run(value: string) { return value } }
`)
    expect(result).toEqual(new Map([
      ["explicit", "export const explicit: <A>(value: A) => A"],
      ["asserted", "export const asserted"],
      ["factory", "export const factory"],
      ["alias", "export const alias"],
      ["object", "export const object"]
    ]))
  })

  it("preserves comment shaped literals in callable defaults and declared types", async () => {
    const result = await signatures(`
export const marker = (value: "/*value*/" = "/*value*/"): "/*result*/" => "/*result*/"
`)
    expect(result.get("marker")).toBe('export const marker = (value: "/*value*/" = "/*value*/"): "/*result*/" => …')
  })

  it("elides function bodies after nonzero source offsets and preserves declared literal types", async () => {
    const result = await signatures(`
// A prefix puts the declaration beyond offset zero.
export function marker(value: "/*value*/" = "/*value*/"): "/*result*/" {
  return privateImplementation(value)
}
`)
    expect(result.get("marker")).toBe('export function marker(value: "/*value*/" = "/*value*/"): "/*result*/"')
  })
})

describe.each<BrainFormat>(["baseline", "compact", "trimmed"])("callable evidence through %s storage", format => {
  it("merges the interface and callable while preserving overloads and exact qualified identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "typelatch-callable-build-"))
    try {
      mkdirSync(join(root, "src"))
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }))
      writeFileSync(join(root, "src", "Schema.ts"), `
export interface NonEmptyArray<Value> { readonly value: Value }
export const NonEmptyArray = <Value>(value: Value): NonEmptyArray<Value> => ({ value })
export function decode(value: string): string
export function decode(value: number): number
export function decode(value: string | number): string | number { return value }
`)
      writeFileSync(join(root, "src", "Other.ts"), "export const NonEmptyArray = (value: boolean): boolean => value\n")
      vi.mocked(resolvePackage).mockResolvedValue({ name: "fixture", version: "1.2.3", integrity: "sha512-callable-fixture", tarballUrl: "https://example.invalid/fixture.tgz" })
      vi.mocked(packPackage).mockResolvedValue({ directory: root, packageRoot: root, tarballPath: "", packedBytes: 0, unpackedBytes: 600, cleanup: async () => {} })
      const built = await buildBrain("fixture@1.2.3", { output: join(root, "brain.db"), format })
      const options = { version: "1.2.3", brainFile: built.path, recordUsage: false }
      const result = getSymbol("fixture", "Schema.NonEmptyArray", options)
      expect(result.lookup).toEqual({ status: "exact", matchedBy: "qualified-name", totalMatches: 1, omitted: 0 })
      expect(result.results.map(symbol => symbol.symbol)).toEqual(["Schema.NonEmptyArray"])
      expect(result.results[0]?.signature).toBe("export interface NonEmptyArray<Value> { readonly value: Value }\n\nexport const NonEmptyArray = <Value>(value: Value): NonEmptyArray<Value> => …")
      expect(result.results[0]).toMatchObject({ kind: "const", source: "src/Schema.ts", line: 2 })
      expect(built.metadata).toMatchObject({ package: "fixture", version: "1.2.3", integrity: "sha512-callable-fixture", format })
      expect(getSymbol("fixture", "Schema.nonEmptyArray", options).results).toEqual([])
      expect(getSymbol("fixture", "NonEmptyArray", options).lookup?.status).toBe("ambiguous")
      expect(getSymbol("fixture", "Schema.decode", options).results[0]?.signature).toBe("export function decode(value: string): string\n\nexport function decode(value: number): number\n\nexport function decode(value: string | number): string | number")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
