import { cpSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
const started=performance.now();
cpSync("artifacts/research/large-monorepo/pnpm-installed", "artifacts/research/cross-package/impact/pnpm-workspace", { recursive:true, dereference:false, verbatimSymlinks:true });
writeFileSync("artifacts/research/cross-package/impact/pnpm-copy.json", JSON.stringify({source:"artifacts/research/large-monorepo/pnpm-installed",copyElapsedMs:performance.now()-started,verbatimSymlinks:true},null,2)+"\n");
