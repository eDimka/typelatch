import { queryBrain } from "./query.js"

export const EFFECT_CASES = [
  {
    question: "How do I retry an operation with exponential delay?",
    expected: ["Effect.retry", "Schedule.exponential"]
  },
  {
    question: "How should I create a service with dependencies?",
    expected: ["Effect.Service", "Effect.provide"]
  },
  {
    question: "decode unknown input with Schema",
    expected: ["Schema.decodeUnknown"]
  },
  {
    question: "How do I safely acquire and release a resource?",
    expected: ["Effect.acquireUseRelease"]
  },
  {
    question: "run effects sequentially collecting all results",
    expected: ["Effect.all"]
  },
  {
    question: "Where is Effect.gen defined?",
    expected: ["Effect.gen"]
  },
  {
    question: "race two effects and return the first result",
    expected: ["Effect.raceFirst"]
  },
  {
    question: "timeout an effect after a duration",
    expected: ["Effect.timeout"]
  },
  {
    question: "fork an effect in the background",
    expected: ["Effect.fork"]
  },
  {
    question: "repeat a successful effect according to a schedule",
    expected: ["Effect.repeat"]
  },
  {
    question: "Where is Clock.currentTimeMillis defined?",
    expected: ["Clock.currentTimeMillis"]
  },
  {
    question: "match both cases of an Option",
    expected: ["Option.match"]
  },
  {
    question: "collect a Stream into a Chunk",
    expected: ["Stream.runCollect"]
  },
  {
    question: "Where is Ref.make defined?",
    expected: ["Ref.make"]
  },
  {
    question: "create a bounded Queue",
    expected: ["Queue.bounded"]
  },
  {
    question: "run an Effect as a Promise",
    expected: ["Effect.runPromise"]
  },
  {
    question: "catch any error and recover with another effect",
    expected: ["Effect.catchAll"]
  },
  {
    question: "merge two layers",
    expected: ["Layer.merge"]
  },
  {
    question: "create a schedule with a fixed interval",
    expected: ["Schedule.fixed"]
  },
  {
    question: "log a message from an Effect",
    expected: ["Effect.log"]
  }
] as const

export type BenchmarkCase = {
  question: string
  expected: readonly string[]
}

export type BenchmarkReport = {
  package: string
  version: string
  cases: number
  passedCases: number
  taskPassRate: number
  expectedSymbols: number
  foundSymbols: number
  recallAt5: number
  meanReciprocalRank: number
  averageLatencyMs: number
  estimatedResultTokens: number
  results: Array<{
    question: string
    expected: readonly string[]
    returned: string[]
    found: string[]
    passed: boolean
    latencyMs: number
  }>
}

export type BenchmarkOptions = {
  version?: string
  brainFile?: string
}

export function runBenchmark(
  packageName: string,
  cases: readonly BenchmarkCase[],
  options: BenchmarkOptions = {}
): BenchmarkReport {
  const results = cases.map((testCase) => {
    const response = queryBrain(packageName, testCase.question, {
      ...(options.version ? { version: options.version } : {}),
      ...(options.brainFile ? { brainFile: options.brainFile } : {}),
      limit: 5,
      recordUsage: false
    })
    const returned = response.results.map((result) => result.symbol)
    const found = testCase.expected.filter((symbol) => returned.includes(symbol))
    return {
      question: testCase.question,
      expected: testCase.expected,
      returned,
      found,
      passed: found.length === testCase.expected.length,
      latencyMs: response.latencyMs
    }
  })
  const expectedSymbols = results.reduce((total, result) => total + result.expected.length, 0)
  const foundSymbols = results.reduce((total, result) => total + result.found.length, 0)
  const reciprocalRanks = results.flatMap((result) => result.expected.map((symbol) => {
    const rank = result.returned.indexOf(symbol)
    return rank < 0 ? 0 : 1 / (rank + 1)
  }))
  const passedCases = results.filter((result) => result.passed).length
  return {
    package: packageName,
    version: options.version ?? "newest installed",
    cases: results.length,
    passedCases,
    taskPassRate: results.length === 0 ? 0 : passedCases / results.length,
    expectedSymbols,
    foundSymbols,
    recallAt5: expectedSymbols === 0 ? 0 : foundSymbols / expectedSymbols,
    meanReciprocalRank: reciprocalRanks.length === 0
      ? 0
      : reciprocalRanks.reduce((sum, rank) => sum + rank, 0) / reciprocalRanks.length,
    averageLatencyMs: results.length === 0
      ? 0
      : results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length,
    estimatedResultTokens: Math.ceil(JSON.stringify(results).length / 4),
    results
  }
}

export function benchmarkEffect(version?: string, brainFile?: string): BenchmarkReport {
  return runBenchmark("effect", EFFECT_CASES, {
    ...(version ? { version } : {}),
    ...(brainFile ? { brainFile } : {})
  })
}

export function formatBenchmark(report: BenchmarkReport): string {
  const lines = [
    `${report.package} retrieval benchmark (${report.version})`,
    `Task pass rate: ${(report.taskPassRate * 100).toFixed(1)}% (${report.passedCases}/${report.cases})`,
    `Expected-symbol recall@5: ${(report.recallAt5 * 100).toFixed(1)}% (${report.foundSymbols}/${report.expectedSymbols})`,
    `Mean reciprocal rank: ${report.meanReciprocalRank.toFixed(3)}`,
    `Average local latency: ${report.averageLatencyMs.toFixed(2)} ms`,
    `Estimated benchmark result context: ${report.estimatedResultTokens.toLocaleString()} tokens`,
    ""
  ]
  for (const result of report.results) {
    lines.push(
      `${result.passed ? "✓" : "✗"} ${result.question}`,
      `  expected: ${result.expected.join(", ")}`,
      `  top 5: ${result.returned.join(", ")}`
    )
  }
  return lines.join("\n")
}
