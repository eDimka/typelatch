import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

describe("interactive MCP setup", () => {
  let directory: string
  let root: string
  let bin: string
  let log: string
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  const run = (input: string, args: string[] = []) => spawnSync("/bin/bash", [join(root, "scripts/setup-mcp.sh"), ...args], {
    input, encoding: "utf8", timeout: 10_000, cwd: directory,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, SETUP_LOG: log, SETUP_ROOT: root },
  })
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[])

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-setup-")))
    root = join(directory, "checkout with spaces")
    bin = join(directory, "bin with spaces")
    log = join(directory, "calls.jsonl")
    mkdirSync(join(root, "scripts"), { recursive: true })
    mkdirSync(join(root, "dist"))
    mkdirSync(bin)
    writeFileSync(log, "")
    writeFileSync(join(root, "dist/mcp.js"), "")
    copyFileSync(resolve("scripts/setup-mcp.sh"), join(root, "scripts/setup-mcp.sh"))
    symlinkSync(process.execPath, join(bin, "node"))
    const record = `node -e 'require("node:fs").appendFileSync(process.env.SETUP_LOG, JSON.stringify(process.argv.slice(1)) + "\\n")' "$0" "$@"`
    stub("codex", record)
    stub("claude", record)
    stub("typelatch-mcp", "exit 0")
    stub("npx", "exit 0")
    stub("npm", `${record}\nif [[ "$1" == view ]]; then printf '0.1.1\\n'; else [[ "$PWD" == "$SETUP_ROOT" ]] || exit 1; fi`)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it("builds from its own directory and registers paths with spaces as single arguments", () => {
    const result = run("\n\n\ny\n")
    expect(result.status, result.stderr).toBe(0)
    expect(calls()).toEqual([
      [join(bin, "npm"), "ci"],
      [join(bin, "npm"), "run", "build"],
      [join(bin, "codex"), "mcp", "add", "typelatch", "--", join(bin, "node"), join(root, "dist/mcp.js")],
    ])
    expect(result.stdout).toContain("Registered typelatch with codex")
  })

  it("registers an installed executable with Claude user scope", () => {
    const result = run("2\n2\nmy_typelatch\nyes\n")
    expect(result.status, result.stderr).toBe(0)
    expect(calls()).toEqual([[join(bin, "claude"), "mcp", "add", "--transport", "stdio", "--scope", "user", "my_typelatch", "--", join(bin, "typelatch-mcp")]])
  })

  it("offers first use setup from an npm package without a checkout or global install", () => {
    const result = run("1\n\ny\n", ["--package-version", "0.2.0"])
    expect(result.status, result.stderr).toBe(0)
    expect(calls()).toEqual([
      [join(bin, "codex"), "mcp", "add", "typelatch", "--", join(bin, "npx"), "--yes", "--package=typelatch@0.2.0", "typelatch-mcp"],
    ])
    expect(result.stdout).not.toContain("Launch method")
    expect(result.stdout).not.toContain("This checkout")
  })

  it("registers the running package version with Claude without persisting its temporary path", () => {
    const result = run("2\n\ny\n", ["--package-version", "0.2.0"])
    expect(result.status, result.stderr).toBe(0)
    expect(calls()).toEqual([
      [join(bin, "claude"), "mcp", "add", "--transport", "stdio", "--scope", "user", "typelatch", "--", join(bin, "npx"), "--yes", "--package=typelatch@0.2.0", "typelatch-mcp"],
    ])
    expect(JSON.stringify(calls())).not.toContain(root)
  })

  it("pins the published version for npm launch", () => {
    const result = run("1\n3\n\n\ny\n")
    expect(result.status, result.stderr).toBe(0)
    expect(calls()).toEqual([
      [join(bin, "npm"), "view", "typelatch", "version"],
      [join(bin, "npm"), "view", "typelatch@0.1.1", "version"],
      [join(bin, "codex"), "mcp", "add", "typelatch", "--", join(bin, "npx"), "--yes", "--package=typelatch@0.1.1", "typelatch-mcp"],
    ])
  })

  it("does not install, build or register when confirmation is declined or input ends", () => {
    expect(run("\n\n\n\n").status).toBe(0)
    expect(run("\n\n\n").status).toBe(1)
    expect(calls()).toEqual([])
  })

  it("stops before registration if the build fails", () => {
    mkdirSync(join(root, "node_modules"))
    stub("npm", "exit 42")
    const result = run("\n\n\ny\n")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Build failed")
    expect(calls()).toEqual([])
  })

  it("does not register an unavailable npm version", () => {
    stub("npm", 'if [[ "$2" == typelatch ]]; then printf "0.1.1\\n"; else exit 1; fi')
    const result = run("1\n3\n0.2.0\n\ny\n")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("typelatch@0.2.0 is not available")
    expect(calls()).toEqual([])
  })

  it("rejects shell syntax and option injection in input", () => {
    expect(run("1\n2\n--help\n").status).toBe(1)
    expect(run("1\n3\n$(touch injected)\n").status).toBe(1)
    expect(calls().every(call => call[1] === "view")).toBe(true)
  })

  it("reports client failure without claiming registration succeeded", () => {
    stub("claude", "exit 1")
    const result = run("2\n2\n\ny\n")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("MCP registration failed")
    expect(result.stdout).not.toContain("Registered")
  })

  it("fails clearly for a missing executable and supports help without changes", () => {
    rmSync(join(bin, "typelatch-mcp"))
    expect(run("1\n2\n").stderr).toContain("typelatch-mcp is not on PATH")
    expect(run("", ["--help"]).status).toBe(0)
    expect(calls()).toEqual([])
  })
})
