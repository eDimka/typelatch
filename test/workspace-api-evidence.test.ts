import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { workspaceContext } from "../src/workspace/context.js"
import { createBrainDatabase } from "../src/database.js"

const roots: string[] = []
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
function fixture(text: string, source = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-api-evidence-")))
  roots.push(root)
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  write("package.json", '{"name":"api-consumer","version":"1.0.0","type":"module"}')
  write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, types: [], skipLibCheck: true }, files: ["main.ts"] }))
  const entry = source ? "index.ts" : "index.d.ts"
  write("node_modules/api-fixture/package.json", JSON.stringify({ name: "api-fixture", version: "1.2.3", type: "module", exports: { ".": { types: `./${entry}` }, "./private": null } }))
  write(`node_modules/api-fixture/${entry}`, text)
  write("node_modules/api-fixture/private.d.ts", "export declare const hidden: string;")
  symlinkSync(resolve("node_modules/typescript"), join(root, "node_modules/typescript"), "dir")
  symlinkSync(join(root, "node_modules/api-fixture"), join(root, "node_modules/fixture-alias"), "dir")
  write("main.ts", 'import * as Api from "api-fixture";\nimport * as Renamed from "fixture-alias";\nvoid Api; void Renamed;\n')
  vi.stubEnv("TYPELATCH_HOME", join(root, "empty-state"))
  return { root, text, entry: join(root, "node_modules/api-fixture", entry), write, request: { config: join(root, "tsconfig.json"), file: "main.ts", importSpecifier: "api-fixture", expectedVersion: "1.2.3" } }
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("named installed API evidence", () => {
  it.each(["missing-modifiers", "older-factory"])("preserves resolved APIs when header normalization lacks %s", capability => {
    const f = fixture("export function parse(input: string): number { return input.length; }\n", true)
    rmSync(join(f.root, "node_modules/typescript"))
    f.write("node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: capability === "older-factory" ? "4.7.4" : "6.0.3", main: "index.cjs" }))
    f.write("node_modules/typescript/index.cjs", `const T = require(${JSON.stringify(resolve("node_modules/typescript"))});
module.exports = { ...T, ${capability === "older-factory" ? 'version: "4.7.4", versionMajorMinor: "4.7",' : 'getModifiers: undefined,'}
  factory: { ...T.factory, updateFunctionDeclaration() { throw new Error("Incompatible header factory must not run"); } }
};\n`)
    const result = workspaceContext({ ...f.request, symbol: "parse" })
    expect(result.api).toMatchObject({ type: "(input: string) => number", signatures: ["(input: string): number"], evidence: {
      declarations: { headers: [{ status: "unsupported", header: null, characters: null, sha256: hash(f.text), reason: expect.stringContaining("compiler") }] }
    } })
    expect(result.checks.resolved.status).toBe("pass")
    expect(result.checks.versionMatch.status).toBe("pass")
    expect(result.checks.typechecked.status).toBe("not-run")
  })

  it("keeps the merged declared interface view and also returns the callable value signature", () => {
    const f = fixture("export interface Box<T> { readonly value: T }\nexport declare const Box: <T>(value: T) => Box<T>;\n")
    const result = workspaceContext({ ...f.request, symbol: "Box" })
    expect(result.api?.type).toBe("Box<T>")
    expect(result.api?.signatures).toEqual(["<T>(value: T): Box<T>"])
    expect(result.api).toMatchObject({ evidence: { signatures: { origin: "compiler", view: "value", total: 1, returned: 1, omitted: 0 } } })
    expect(result.checks).toMatchObject({ resolved: { status: "pass" }, versionMatch: { status: "pass" }, artifactMatch: { status: "unknown" }, typechecked: { status: "not-run" }, tested: { status: "not-run" } })
    expect(result.brain).toBeNull()
  })

  it("identifies a named installed request as installed API evidence without changing cursor or discovery routes", () => {
    const f = fixture("export declare function decode(value: string): number;\n")
    expect(workspaceContext({ ...f.request, symbol: "decode" }).route).toBe("installed-api")
    expect(workspaceContext({ ...f.request, symbol: "decode", position: 12 }).route).toBe("language-service-first")
    expect(workspaceContext({ ...f.request, symbol: "decode", question: "decode" }).route).toBe("brain-discovery")
    expect(workspaceContext(f.request).route).toBe("brain-discovery")
  })

  it("reports complete counts when twelve overloads exceed the ten signature and declaration caps", () => {
    const overloads = Array.from({ length: 12 }, (_, i) => `export function choose(value: "v${i}"): "r${i}";`).join("\n")
    const f = fixture(`${overloads}\nexport function choose(value: string): string { return value; }\n`, true)
    const result = workspaceContext({ ...f.request, symbol: "choose" })
    expect(result.api?.signatures).toHaveLength(10)
    expect(result.api?.declarations).toHaveLength(10)
    expect(result.api?.type).toContain('(value: "v11"): "r11"')
    expect(result.api).toMatchObject({ evidence: {
      characterUnit: "utf16-code-units",
      signatures: { origin: "compiler", view: "value", total: 12, returned: 10, omitted: 2 },
      declarations: { origin: "declared-syntax", total: 13, returned: 10, omitted: 3 }
    } })
  })

  it("returns declared arrow syntax and source provenance separately from its inferred compiler return", () => {
    const f = fixture('/** Return the input length. */\nexport const size = (value: "/*literal*/" = "/*literal*/") => { return value.length; };\n', true)
    const result = workspaceContext({ ...f.request, symbol: "size" })
    expect(result.api?.signatures).toEqual(['(value?: "/*literal*/"): number'])
    expect(result.api).toMatchObject({ evidence: { declarations: { headers: [{
      file: f.entry,
      sha256: hash(f.text),
      sourceKind: "source",
      header: 'const size = (value: "/*literal*/" = "/*literal*/") => …',
      status: "complete",
      elisions: ["function-body"]
    }] } } })
    expect(readFileSync(f.entry, "utf8")).toBe(f.text)
  })
})

describe("declared syntax and compiler evidence boundaries", () => {
  it("preserves pure callable type aliases and keeps constructor types separate from call signatures", () => {
    const f = fixture("export type Callback = (value: string) => number;\nexport declare class Box { constructor(value: string); private secret; }\n")
    expect(workspaceContext({ ...f.request, symbol: "Callback" }).api).toMatchObject({ signatures: ["(value: string): number"], evidence: { signatures: { view: "declared-type", total: 1 } } })
    expect(workspaceContext({ ...f.request, symbol: "Box" }).api).toMatchObject({ type: "typeof Box", signatures: [], evidence: {
      signatures: { view: "value", total: 0, returned: 0, omitted: 0 },
      declarations: { headers: [{ header: "export declare class Box { … }", elisions: ["class-members"], status: "complete" }] }
    } })
  })

  it("retains published annotations and interface members without adding inferred signatures to headers", () => {
    const f = fixture("export interface Result<T> { readonly value: T; map<A>(f: (value: T) => A): Result<A> }\nexport declare const make: <T>(value: T) => Result<T>;\n")
    expect(workspaceContext({ ...f.request, symbol: "make" }).api).toMatchObject({ evidence: { declarations: { headers: [{ sourceKind: "declaration", header: "const make: <T>(value: T) => Result<T>", elisions: [], status: "complete" }] } } })
    const result = workspaceContext({ ...f.request, symbol: "Result" })
    expect(result.api?.evidence.declarations.headers[0]?.header).toContain("readonly value: T;")
    expect(result.api?.evidence.declarations.headers[0]?.header).toContain("map<A>(f: (value: T) => A): Result<A>;")
    expect(result.api?.evidence.declarations.headers[0]?.elisions).toEqual([])
  })

  it("keeps annotated variables authoritative and elides factory or assertion initializers without inventing declared callability", () => {
    const f = fixture('type Callable = (value: string) => number;\nexport const typed: Callable = value => value.length;\nexport const factory = (() => (value: string) => value.length)();\nexport const asserted = ((value: string) => value.length) as Callable;\n', true)
    for (const [symbol, header] of [["typed", "const typed: Callable"], ["factory", "const factory"], ["asserted", "const asserted"]]) {
      expect(workspaceContext({ ...f.request, symbol }).api).toMatchObject({ evidence: { declarations: { headers: [{ header, elisions: ["initializer"], status: "complete" }] } } })
    }
  })

  it("elides nested executable default bodies while retaining literal syntax and declared outer returns", () => {
    const f = fixture('export function invoke(cb = () => { const INNER_SECRET = "no"; return INNER_SECRET; }, marker: "/*literal*/" = "/*literal*/"): string { return OUTER_SECRET; }\n', true)
    const result = workspaceContext({ ...f.request, symbol: "invoke" })
    const header = result.api?.evidence.declarations.headers[0]
    expect(header?.header).toContain('marker: "/*literal*/" = "/*literal*/"')
    expect(header?.header).toContain("): string")
    expect(header?.header).not.toContain("INNER_SECRET")
    expect(header?.header).not.toContain("OUTER_SECRET")
    expect(header?.elisions).toEqual(["function-body", "nested-function-body"])
    expect(header?.status).toBe("complete")
  })

  it("elides named generator expression and class or namespace implementations without mislabeling members as returned", () => {
    const f = fixture('export const items = function* named<T>(value: T): Generator<T> { yield SECRET; };\nexport namespace Tools { export function run() { return SECRET; } }\nexport class Container<T> { constructor(value: T) { SECRET(); } run() { return SECRET; } }\n', true)
    const generator = workspaceContext({ ...f.request, symbol: "items" }).api?.evidence.declarations.headers[0]
    expect(generator?.header).toContain("function* named<T>(value: T): Generator<T>")
    expect(generator?.header).not.toContain("SECRET")
    expect(generator?.elisions).toEqual(["function-body"])
    expect(workspaceContext({ ...f.request, symbol: "Tools" }).api).toMatchObject({ evidence: { declarations: { headers: [{ header: "export namespace Tools { … }", elisions: ["namespace-members"] }] } } })
    expect(workspaceContext({ ...f.request, symbol: "Container" }).api).toMatchObject({ evidence: { declarations: { headers: [{ header: "export class Container<T> { … }", elisions: ["class-members"] }] } } })
  })

  it("preserves renamed, default and npm alias identity while locating the original overload declarations", () => {
    const f = fixture('export function parse(value: string): number;\nexport function parse(value: number): string;\nexport { parse as renamed, parse as default };\n')
    const original = workspaceContext({ ...f.request, symbol: "parse" })
    for (const symbol of ["renamed", "default"]) {
      const result = workspaceContext({ ...f.request, symbol, importSpecifier: "fixture-alias" })
      expect(result.api?.name).toBe(symbol)
      expect(result.api?.signatures).toEqual(original.api?.signatures)
      expect(result.api?.declarations).toEqual(original.api?.declarations)
      expect(result.api?.evidence.declarations.headers).toEqual(original.api?.evidence.declarations.headers)
      expect(result.dependency).toMatchObject({ name: "api-fixture", version: "1.2.3" })
    }
    expect(original.api?.evidence.declarations).toMatchObject({ total: 2, returned: 2, omitted: 0 })
  })

  it("keeps empty documentation explicit and returns bounded compiler tags separately from prose", () => {
    const f = fixture('export declare function empty(): void;\n/** Convert a value.\n * @since 1.0.0\n * @example convert("x")\n */\nexport declare function convert(value: string): number;\n')
    expect(workspaceContext({ ...f.request, symbol: "empty" }).api).toMatchObject({ documentation: "", evidence: {
      documentation: { origin: "compiler-documentation", total: 0, returned: 0, omitted: 0 },
      tags: { origin: "compiler-jsdoc-tags", total: 0, returned: 0, omitted: 0, items: [] }
    } })
    expect(workspaceContext({ ...f.request, symbol: "convert" }).api).toMatchObject({ documentation: "Convert a value.", evidence: { tags: {
      origin: "compiler-jsdoc-tags", total: 2, returned: 2, omitted: 0,
      items: [{ name: "since", text: "1.0.0" }, { name: "example", text: 'convert("x")' }]
    } } })
  })

  it("reports exact UTF16 omissions for long type text and documentation while preserving their existing caps", () => {
    const literal = "🙂".repeat(8501)
    const prose = "a" + "🙂".repeat(6000)
    const f = fixture(`/** ${prose} */\nexport declare const huge: "${literal}";\n`)
    const api = workspaceContext({ ...f.request, symbol: "huge" }).api
    expect(api?.type.length).toBe(16000)
    expect(api?.documentation.length).toBe(12000)
    expect(api).toMatchObject({ evidence: {
      type: { origin: "compiler", total: 17004, returned: 16000, omitted: 1004 },
      documentation: { origin: "compiler-documentation", total: 12001, returned: 12000, omitted: 1 }
    } })
  })

  it("counts full compiler signature characters before the eight thousand character cap", () => {
    const literal = "x".repeat(8100)
    const f = fixture(`export declare function huge(value: "${literal}"): void;\n`)
    const api = workspaceContext({ ...f.request, symbol: "huge" }).api
    expect(api?.signatures[0]?.length).toBe(8000)
    expect(api).toMatchObject({ evidence: {
      signatures: { characters: [{ total: 8117, returned: 8000, omitted: 117 }] },
      declarations: { headers: [{ status: "truncated", characters: { total: 8146, returned: 8000, omitted: 146 } }] }
    } })
  })

  it("caps tag counts and tag names and text with exact omission evidence", () => {
    const name = "a".repeat(270)
    const docs = ["/** Tags only.", ` * @${name} ${"b".repeat(4100)}`, ...Array.from({ length: 11 }, (_, i) => ` * @tag${i} value`), " */"].join("\n")
    const f = fixture(`${docs}\nexport declare function tagged(): void;\n`)
    const tags = workspaceContext({ ...f.request, symbol: "tagged" }).api?.evidence.tags
    expect(tags).toMatchObject({ origin: "compiler-jsdoc-tags", total: 12, returned: 10, omitted: 2 })
    expect(tags?.items[0]).toMatchObject({ name: "a".repeat(256), text: "b".repeat(4000), nameCharacters: { total: 270, returned: 256, omitted: 14 }, textCharacters: { total: 4100, returned: 4000, omitted: 100 } })
  })

  it("marks malformed and nonpublic member headers unsupported instead of returning fabricated declared syntax", () => {
    const f = fixture('export const broken = (value: string): => value;\nexport class Secrets { private static hidden(value: string) { return value; } }\n', true)
    for (const symbol of ["broken", "Secrets.hidden"]) {
      const result = workspaceContext({ ...f.request, symbol })
      expect(result.api).not.toBeNull()
      expect(result.api).toMatchObject({ evidence: { declarations: { headers: [{ header: null, status: "unsupported", characters: null, reason: expect.any(String) }] } } })
    }
  })

  it("hashes the actual overlaid declaration text and returns to disk without stale header evidence", () => {
    const f = fixture('export declare function pick(value: "one"): "one";\n')
    const text = f.text.replaceAll('"one"', '"two"')
    const first = workspaceContext({ ...f.request, symbol: "pick" })
    const overlay = workspaceContext({ ...f.request, symbol: "pick", overlays: [{ file: f.entry, text }] })
    const final = workspaceContext({ ...f.request, symbol: "pick" })
    expect(first.api?.evidence.declarations.headers[0]?.sha256).toBe(hash(f.text))
    expect(overlay.api?.evidence.declarations.headers[0]?.sha256).toBe(hash(text))
    expect(overlay.api?.evidence.declarations.headers[0]?.header).toContain('"two"')
    expect(overlay.snapshot.id).not.toBe(first.snapshot.id)
    expect(final.api?.evidence).toEqual(first.api?.evidence)
    expect(final.snapshot.id).toBe(first.snapshot.id)
    expect(readFileSync(f.entry, "utf8")).toBe(f.text)
    writeFileSync(f.entry, text)
    expect(workspaceContext({ ...f.request, symbol: "pick" }).api?.evidence.declarations.headers[0]?.sha256).toBe(hash(text))
  })

  it("keeps missing names, blocked imports and failed expected version checks in their existing states", () => {
    const f = fixture("export declare function present(): void;\n")
    const missing = workspaceContext({ ...f.request, symbol: "absent" })
    expect(missing.api).toBeNull()
    expect(missing.checks.resolved.status).toBe("pass")
    const blocked = workspaceContext({ ...f.request, importSpecifier: "api-fixture/private", symbol: "hidden" })
    expect(blocked.api).toBeNull()
    expect(blocked.dependency).toBeNull()
    expect(blocked.checks.resolved.status).toBe("unknown")
    const wrong = workspaceContext({ ...f.request, symbol: "present", expectedVersion: "0.0.0" })
    expect(wrong.api?.name).toBe("present")
    expect(wrong.dependency?.version).toBe("1.2.3")
    expect(wrong.checks.versionMatch.status).toBe("fail")
    expect(wrong.checks.artifactMatch.status).toBe("unknown")
  })
})

it("returns complete headers and signatures exactly at their character caps", () => {
  const f = fixture(`export declare function huge(value: "${"x".repeat(7954)}"): void;\nexport declare function edge(value: "${"x".repeat(7983)}"): void;\n`)
  expect(workspaceContext({ ...f.request, symbol: "huge" }).api?.evidence.declarations.headers[0]).toMatchObject({ status: "complete", characters: { total: 8000, returned: 8000, omitted: 0 } })
  expect(workspaceContext({ ...f.request, symbol: "edge" }).api?.evidence.signatures.characters[0]).toEqual({ total: 8000, returned: 8000, omitted: 0 })
})

it("retains an anonymous default function header without inventing a name or inferred return", () => {
  const f = fixture('export default function(value: string) { return value.length; }\n', true)
  const result = workspaceContext({ ...f.request, symbol: "default" })
  expect(result.api?.signatures).toEqual(["(value: string): number"])
  const header = result.api?.evidence.declarations.headers[0]
  expect(header?.header).toBe("export default function (value: string);")
  expect(header?.elisions).toEqual(["function-body"])
})

it("elides method and accessor bodies nested in parameter defaults", () => {
  const f = fixture('export function run(cb = { run() { return METHOD_SECRET; }, get value() { return GETTER_SECRET; } }.run): void { OUTER_SECRET(); }\n', true)
  const result = workspaceContext({ ...f.request, symbol: "run" })
  const header = result.api?.evidence.declarations.headers[0]
  expect(header?.header).toContain("run()")
  expect(header?.header).toContain("get value()")
  expect(header?.header).not.toContain("SECRET")
  expect(header?.elisions).toEqual(["function-body", "nested-function-body"])
})

it("repairs merged signatures for discovery candidates without replicating heavy declared evidence", () => {
  const f = fixture("export interface Box<T> { readonly value: T }\nexport declare const Box: <T>(value: T) => Box<T>;\n")
  const directory = join(f.root, "empty-state/brains/api-fixture/1.2.3")
  mkdirSync(directory, { recursive: true })
  const db = createBrainDatabase(join(directory, "brain.db"), "baseline")
  try {
    db.prepare("INSERT INTO metadata(key,value) VALUES ('package','api-fixture'),('version','1.2.3'),('integrity','authored-fixture')").run()
    db.prepare("INSERT INTO symbols(qualified_name,name,kind,module,signature,docs,source_path,line_start,line_end,source,is_public,is_deprecated,is_internal,category,example_count) VALUES ('api_fixture.Box','Box','const','api_fixture','fixture signature','box fixture','index.d.ts',1,2,'',1,0,0,NULL,0)").run()
    db.prepare("INSERT INTO symbol_search(rowid,title,body,tags) VALUES (1,'api_fixture.Box','box fixture','public')").run()
  } finally { db.close() }
  const result = workspaceContext({ ...f.request, question: "api_fixture.Box" })
  expect(result.api).toBeNull()
  expect(result.candidates[0]?.workspaceExport?.signatures).toEqual(["<T>(value: T): Box<T>"])
  expect(result.candidates[0]?.workspaceExport).not.toHaveProperty("evidence")
  expect(result.candidates[0]?.artifactEquivalent).toBe(false)
})

it("elides executable bodies in retained class heritage expressions", () => {
  const f = fixture('declare function base(value: () => number): new () => object;\nexport class Derived extends base(() => { return HERITAGE_SECRET; }) { method() { MEMBER_SECRET(); } }\n', true)
  const header = workspaceContext({ ...f.request, symbol: "Derived" }).api?.evidence.declarations.headers[0]
  expect(header?.header).toContain("extends base(() =>")
  expect(header?.header).not.toContain("SECRET")
  expect(header?.elisions).toEqual(["class-members", "nested-function-body"])
  expect(header?.status).toBe("complete")
})

it.each(["using", "await using"])("preserves the %s resource binding kind", binding => {
  const f = fixture(`${binding} resource = null;\nexport { resource };\n`, true)
  expect(workspaceContext({ ...f.request, symbol: "resource" }).api?.evidence.declarations.headers[0]).toMatchObject({
    header: `${binding} resource`, status: "complete", elisions: ["initializer"]
  })
})

it("omits all members of a nested class default including field initializers", () => {
  const f = fixture(`export function make(Base = class Nested extends Object {
  field = CLASS_FIELD_SECRET;
  static cached = STATIC_FIELD_SECRET;
  #private = PRIVATE_FIELD_SECRET;
  constructor() { super(); CONSTRUCTOR_SECRET(); }
  run() { METHOD_SECRET(); }
  static { STATIC_BLOCK_SECRET(); }
}): void { OUTER_SECRET(); }
`, true)
  const header = workspaceContext({ ...f.request, symbol: "make" }).api?.evidence.declarations.headers[0]
  expect(header?.header).toContain("class Nested extends Object")
  expect(header?.header).not.toContain("SECRET")
  expect(header?.header).not.toContain("constructor")
  expect(header?.header).not.toContain("field")
  expect(header?.elisions).toEqual(["function-body", "class-members"])
  expect(header?.status).toBe("complete")
})

it("retains nested class generics, heritage arguments and neighboring literal defaults", () => {
  const f = fixture('declare class Parent<T> {}\nexport function make(Base = class Nested<T> extends Parent<string> { field = FIELD_SECRET; }, marker: "/*literal*/" = "/*literal*/"): void { OUTER_SECRET(); }\n', true)
  const header = workspaceContext({ ...f.request, symbol: "make" }).api?.evidence.declarations.headers[0]
  expect(header?.header).toContain("class Nested<T> extends Parent<string>")
  expect(header?.header).toContain('marker: "/*literal*/" = "/*literal*/"')
  expect(header?.header).not.toContain("SECRET")
  expect(header?.elisions).toEqual(["function-body", "class-members"])
})
