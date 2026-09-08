import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { analyzeFile, enrichFromReadme, enrichReExports } from "../src/indexer.js"

async function analyze(text: string) {
  const root = await mkdtemp(join(tmpdir(), "typelatch-docs-"))
  try {
    const file = join(root, "index.d.ts")
    await writeFile(file, text)
    return await analyzeFile(file, root, root, new Set(), "fixture", "declaration")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("declaration documentation evidence", () => {
  it("resolves physical index-module imports and enriches only real re-export targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "typelatch-reexports-"))
    try {
      const source = join(root, "source")
      await mkdir(join(source, "vendor", "support"), { recursive: true })
      await writeFile(join(source, "index.d.ts"), `
import { Level } from "./vendor/support/index.js";
import { Ghost } from "./missing.js";
export { Level };
export { Ghost as ImportedMissing };
export { Level as DirectLevel } from "./vendor/support/index.js";
export { Level as Missing } from "./missing.js";
export { External } from "external-library";
/** Circular export metadata. */
export { Cycle } from "./vendor/support/index.js";
`)
      await writeFile(join(source, "vendor", "support", "index.d.ts"), `
/** Numeric output level: 0 disabled, 1 basic, 2 extended, 3 full. */
export type Level = 0 | 1 | 2 | 3;
export { Level as Back } from "../../index.js";
export { Cycle } from "../../index.js";
`)
      const files = [join(source, "index.d.ts"), join(source, "vendor", "support", "index.d.ts")]
      const analyzed = await Promise.all(files.map((file) => analyzeFile(file, root, root, new Set(), "fixture", "declaration")))
      const symbols = analyzed.flatMap((result) => result.symbols)
      const edges = analyzed.flatMap((result) => result.edges)
      enrichReExports(symbols, edges)
      for (const name of ["Level", "DirectLevel"]) {
        expect(edges).toContainEqual(expect.objectContaining({ fromQualifiedName: `source.${name}`, toQualifiedName: "source/vendor/support.Level", type: "re_exports" }))
        const symbol = symbols.find((entry) => entry.qualifiedName === `source.${name}`)!
        expect(symbol.docs).toContain("0 disabled, 1 basic, 2 extended, 3 full")
        expect(symbol.docs).toContain("source/vendor/support/index.d.ts:3-3")
      }
      expect(symbols.find((entry) => entry.qualifiedName === "source.Missing")!.docs).toBe("")
      expect(edges.some((edge) => edge.fromQualifiedName === "source.Missing")).toBe(false)
      expect(edges.some((edge) => edge.fromQualifiedName === "source.ImportedMissing")).toBe(false)
      expect(edges).toContainEqual(expect.objectContaining({ fromQualifiedName: "source.External", toQualifiedName: "external_library.External", type: "re_exports" }))
      expect(symbols.find((entry) => entry.qualifiedName === "source.External")!.docs).toBe("")
      expect(symbols.find((entry) => entry.qualifiedName === "source/vendor/support.Back")!.docs).toContain("0 disabled")
      expect(symbols.find((entry) => entry.qualifiedName === "source/vendor/support.Cycle")!.docs).toContain("Circular export metadata")
      expect(symbols.every((symbol) => symbol.docs.length <= 20_002)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("respects lexical generic parameters without hiding unshadowed sibling references", async () => {
    const result = await analyze(`
/** Global options documentation must not leak into generic parameters. */
interface Options { configured: boolean }
export type Generic<Options> = (value: Options) => string;
export type Nested = { convert: <Options>(value: Options) => string };
export type Mapping = { [Options in "key"]: Options };
export type Inferred<T> = T extends { value: infer Options } ? Options : never;
export type Conditional<T> = T extends { value: infer Options } ? Options : Options;
export type Actual = (value: Options) => string;
export interface Mixed {
  generic<Options>(value: Options): string;
  concrete(value: Options): string;
}
`)
    for (const name of ["Generic", "Nested", "Mapping", "Inferred"]) {
      expect(result.symbols.find((symbol) => symbol.name === name)!.docs).not.toContain("Global options documentation")
      expect(result.edges.some((edge) => edge.fromQualifiedName === `fixture.${name}` && edge.toQualifiedName === "fixture.Options")).toBe(false)
    }
    expect(result.symbols.find((symbol) => symbol.name === "Actual")!.docs).toContain("Global options documentation")
    for (const name of ["Actual", "Mixed", "Conditional"]) {
      expect(result.edges).toContainEqual(expect.objectContaining({ fromQualifiedName: `fixture.${name}`, toQualifiedName: "fixture.Options", type: "references" }))
    }
  })

  it("retains member descriptions and locations without leaking member lifecycle tags", async () => {
    const result = await analyze(`
/** A reusable parser. */
export class Parser {
  /** Accept an argument with an optional value. */
  option(name: string): this;
  /** @deprecated Use parse instead. */
  legacy(): void;
  /** Parse values without terminating the host process. */
  parse(values: string[]): void;
}
`)
    const parser = result.symbols.find((symbol) => symbol.name === "Parser")!
    expect(parser.docs).toContain("Accept an argument with an optional value.")
    expect(parser.docs).toContain("[Member option; index.d.ts:5]")
    expect(parser.docs).toContain("Parse values without terminating the host process.")
    expect(parser.isDeprecated).toBe(false)
    expect(parser.isInternal).toBe(false)
  })

  it("follows constructor parameter and result types plus intersection surfaces with cycle bounds", async () => {
    const result = await analyze(`
interface Options {
  /** Choose an output encoding explicitly. */
  encoding?: string;
}
interface Instance {
  /** Convert bytes to output text. */
  convert(input: Uint8Array): string;
}
type Factory = (new (options?: Options) => Instance) & Cycle;
type Cycle = Factory & { readonly valid: boolean };
/** Create a converter. */
declare const makeConverter: Factory;
export default makeConverter;
`)
    const factory = result.symbols.find((symbol) => symbol.name === "default")!
    expect(factory.docs).toContain("Choose an output encoding explicitly.")
    expect(factory.docs).toContain("Convert bytes to output text.")
    expect(factory.docs).toContain("Referenced type Factory; index.d.ts:")
    expect(factory.docs.length).toBeLessThanOrEqual(20_002)
    expect(result.edges).toContainEqual(expect.objectContaining({
      fromQualifiedName: "fixture.default", toQualifiedName: "fixture.Factory", type: "references", evidence: "Factory"
    }))
    expect(result.edges.some((edge) => edge.toQualifiedName.endsWith(".Uint8Array"))).toBe(false)
  })

  it("budgets across members so later descriptions survive a large interface", async () => {
    const declarations = Array.from({ length: 80 }, (_, index) => `/** Method ${index} description. ${"detail ".repeat(100)} */\nmethod${index}(): void;`).join("\n")
    const result = await analyze(`export interface Large {\n${declarations}\n}`)
    const symbol = result.symbols[0]!
    expect(symbol.docs).toContain("Method 0 description")
    expect(symbol.docs).toContain("Method 79 description")
    expect(symbol.docs.length).toBeLessThanOrEqual(20_002)
  })

  it("uses only symbol-anchored README sections with line provenance and API boundaries", async () => {
    const { symbols } = await analyze("export class Parser {}\nexport function parse(): void;\nexport class Unrelated {}")
    enrichFromReadme(symbols, [
      "# Package", "General prose mentions Unrelated but supplies no API section.",
      "## Parser Class", "Construct once and retain the parsed representation.",
      "### Methods", "Call match for another filename.",
      "### parse(input)", "Parse one input.",
      "```md", "## Unrelated", "This is only a fenced example.", "```"
    ].join("\n"), "README.md")
    const parser = symbols.find((symbol) => symbol.name === "Parser")!
    expect(parser.docs).toContain("[README README.md:3-6]")
    expect(parser.docs).toContain("retain the parsed representation")
    expect(parser.docs).toContain("another filename")
    expect(parser.docs).not.toContain("Parse one input")
    expect(symbols.find((symbol) => symbol.name === "parse")!.docs).toContain("Parse one input")
    expect(symbols.find((symbol) => symbol.name === "Unrelated")!.docs).toBe("")
  })
})
