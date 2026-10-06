import { z } from "zod"
export const searchSchema = z.object({
  workspaceRoot: z.string().min(1),
  question: z.string().trim().min(1).max(2000),
  file: z.string().min(1).optional(),
  scope: z.enum(["all", "workspace", "dependencies"]).optional(),
  detail: z.enum(["full", "compact"]).optional().describe("Compact preserves all coverage and checks, caps result snippets at 360 characters with explicit omissions, and omits duplicate signatures"),
  limit: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional()
}).strict()
const overlays = z.array(z.object({ file: z.string().min(1), text: z.string().max(1_000_000) }).strict()).max(50).optional()
export const contextSchema = z.object({
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  config: z.string().min(1), file: z.string().min(1),
  symbol: z.string().min(1).max(300).optional(),
  position: z.number().int().nonnegative().optional(),
  importSpecifier: z.string().min(1).optional(), question: z.string().min(1).optional(),
  expectedVersion: z.string().min(1).optional(), overlays,
  limit: z.number().int().min(1).max(20).optional()
}).strict()
export const validationSchema = z.object({
  config: z.string().min(1), overlays,
  testCommand: z.array(z.string()).min(1).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  workspaceRoot: z.string().min(1).optional(),
  runtimeInputs: z.array(z.string().min(1)).max(100).optional(),
  snapshotExclude: z.array(z.string().min(1)).max(100).optional(),
  queryId: z.string().uuid().optional(), record: z.boolean().optional()
}).strict()
