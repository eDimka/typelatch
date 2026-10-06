export type RetryOptions = {
  maxAttempts: number
  delayMs: number
  deadlineMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export class RetryDeadlineError extends Error {
  constructor() { super("Retry deadline reached before the first attempt"); this.name = "RetryDeadlineError" }
}

export async function retry<Value>(operation: (attempt: number) => Promise<Value>, options: RetryOptions): Promise<Value> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer")
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) throw new RangeError("delayMs must be finite and nonnegative")
  if (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs)) throw new RangeError("deadlineMs must be finite")
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = options.deadlineMs ?? Infinity
  let lastError: unknown
  let failed = false
  for (let attempt = 0; attempt <= options.maxAttempts; attempt++) {
    if (now() > deadline) {
      if (failed) throw lastError
      throw new RetryDeadlineError()
    }
    try { return await operation(attempt + 1) }
    catch (error) { lastError = error; failed = true }
    if (attempt < options.maxAttempts) await sleep(options.delayMs)
  }
  throw lastError
}
