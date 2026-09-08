import { cpSync, mkdirSync, rmSync } from "node:fs"

mkdirSync("dist/benchmark", { recursive: true })
cpSync("src/benchmark/corpus.json", "dist/benchmark/corpus.json")
cpSync("src/benchmark/cases", "dist/benchmark/cases", { recursive: true })

for (const suffix of ["js", "js.map", "d.ts"]) rmSync(`dist/comparison.${suffix}`, { force: true })
