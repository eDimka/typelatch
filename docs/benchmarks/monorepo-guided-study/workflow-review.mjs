import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const hash = value => createHash('sha256').update(value).digest('hex')
export const guidedReviewRules = Object.freeze({
  providerInventory: 'Each arm receives the same-format explicit inventory of its actual enabled repository provider and tool names, with none for native. Built-in MCP resource and resource-template catalogs are not repository retrieval providers and must not be called to discover providers. Tool search may load deferred definitions of the declared tools; all its costs remain charged.',
  firstInvestigation: 'The first task-directed source or path search, source read, or targeted dependency/configuration inspection undertaken to investigate the implementation.',
  separatePreliminaryActions: 'Harmless working-directory checks and generic top-level project metadata, the mandatory supplied native check, and provider startup instructions are distinct from source investigation. A targeted source-path search or task-specific dependency/configuration read counts even if it uses a listing or manifest.',
  symmetry: 'Apply the same interpretation to native, Serena and packet. The first investigation must follow the supplied failing check. Native uses native tools; a provider arm attempts its first investigation through the designated provider, then chooses freely.',
  providerStartup: 'Required provider activation and startup instructions do not themselves qualify as relevant retrieval. A serena_repl call that only lists tools, configuration or memories does not qualify.',
  relevance: 'A qualifying retrieval attempt must address the reported task behavior or implementation. Usable evidence, empty results and tool errors remain distinct; failure costs are retained. No forced additional API or validation call.',
  shellOrdering: 'The independent reviewer must assess ordering inside compound shell commands and identify task-directed shell reads or edits. If public command/action evidence cannot establish the order or relevance, record unknown. Aggregate shell exit codes and total tool counts do not prove compliance.',
  evidenceBoundary: 'Review only hash-bound public actions, source changes, native-check observations and grades. Never inspect private reasoning or assistant message bodies. Preserve every run and every failed attempt.',
})

const expectedProvider = arm => arm === 'packet' ? { server: 'typelatch_packet', tool: 'workspace_evidence' } : arm === 'competitor' ? { server: 'serena', tool: 'serena_repl' } : null

// Relevance and shell-internal ordering require independent human judgment.
// This binds that judgment to actual public actions without reading raw model messages.
export function reviewGuidedWorkflow(report, context) {
  if (!context) return { complete: false, passed: false, issues: ['Independent public-action review is pending.'], runs: [] }
  const issues = [], rows = [], { audit, reportBytes, publicRecords, publicOutputs = {} } = context
  if (!isDeepStrictEqual(report.protocol?.workflowReviewRules, guidedReviewRules)) issues.push('Protocol does not contain the frozen first-investigation review rules.')
  if (typeof reportBytes !== 'string' || !audit || typeof publicRecords !== 'object' || publicRecords === null) return { complete: false, passed: false, issues: ['Review context is incomplete.'], runs: [] }
  try {
    if (!isDeepStrictEqual(JSON.parse(reportBytes), report)) issues.push('Review report bytes differ from the evaluated report.')
  } catch { issues.push('Review report bytes are invalid JSON.') }
  if (audit.schemaVersion !== 1 || audit.reportSha256 !== hash(reportBytes) || audit.protocolSha256 !== report.protocolSha256) issues.push('Review is not bound to this report and protocol.')
  if (typeof audit.reviewer !== 'string' || !audit.reviewer.trim() || audit.noPrivateReasoningOrMessages !== true) issues.push('Independent reviewer and evidence boundary must be declared.')
  if (!Array.isArray(audit.runs) || audit.runs.length !== report.runs.length || new Set(audit.runs?.map(row => row.id)).size !== report.runs.length) issues.push('Review must retain one row for every run.')
  for (const [index, run] of report.runs.entries()) {
    const review = audit.runs?.[index], errors = []
    const bytes = publicRecords[run.id]
    let record = null
    try { record = JSON.parse(bytes) } catch { errors.push('Public evidence is unavailable or invalid.') }
    if (typeof bytes !== 'string' || hash(bytes) !== run.evidenceSha256 || review?.evidenceSha256 !== run.evidenceSha256) errors.push('Public evidence hash does not match the run and review.')
    if (!review || review.id !== run.id || record?.run?.id !== run.id) errors.push('Review/public evidence run identity differs.')
    if (review?.instructionFollowed !== 'pass') errors.push('First-investigation compliance is failed or unknown.')
    if (typeof review?.rationale !== 'string' || review.rationale.trim().length < 20) errors.push('A concise evidence-based rationale is required.')
    const actions = Array.isArray(record?.actions) ? record.actions : []
    const firstCheck = run.nativeValidation?.checks?.[0]
    const checkIndex = actions.findIndex(action => action.idSha256 === review?.firstNativeCheckActionIdSha256)
    const investigationIndex = actions.findIndex(action => action.idSha256 === review?.firstInvestigationActionIdSha256)
    if (!firstCheck || firstCheck.passed !== false || firstCheck.actionIdSha256 !== review?.firstNativeCheckActionIdSha256 || checkIndex < 0) errors.push('The first failing native check is not cited.')
    if (investigationIndex < checkIndex || investigationIndex < 0) errors.push('First investigation precedes the failing check or is uncited.')
    if (investigationIndex >= 0 && !['command_execution', 'mcp_tool_call'].includes(actions[investigationIndex].type)) errors.push('First investigation must cite a native or MCP retrieval action.')
    const firstExplicitEdit = actions.findIndex(action => action.type === 'file_change')
    if (firstExplicitEdit >= 0 && investigationIndex >= firstExplicitEdit) errors.push('An explicit source edit precedes the cited investigation.')
    if (actions.some(action => action.type === 'mcp_tool_call' && ['list_mcp_resources', 'list_mcp_resource_templates'].includes(action.tool))) errors.push('Resource-catalog discovery contradicts the explicit provider inventory.')
    const outputBytes = publicOutputs[run.id]
    const needsOutput = review?.returnedEvidence === 'usable' || review?.toolOutputsSha256 != null
    let output = null
    if (needsOutput) {
      try { output = JSON.parse(outputBytes) } catch { errors.push('Claimed returned evidence requires the normalized tool-output supplement.') }
      if (typeof outputBytes !== 'string' || hash(outputBytes) !== review?.toolOutputsSha256) errors.push('Tool-output supplement hash differs from the review.')
      if (output?.publicRecordSha256 !== run.evidenceSha256 || output?.rawCaptureSha256 !== run.rawSha256) errors.push('Tool-output supplement is not bound to this raw capture and public record.')
    }
    const expected = expectedProvider(run.arm)
    let adoption = { required: Boolean(expected), attempted: false, returnedUsableEvidence: null }
    if (expected) {
      const action = actions.find(action => action.idSha256 === review?.providerRetrievalActionIdSha256)
      if (!action || action.type !== 'mcp_tool_call' || action.server !== expected.server || action.tool !== expected.tool) errors.push('A designated provider retrieval action is required; startup instructions do not qualify.')
      if (review?.providerRetrievalActionIdSha256 !== review?.firstInvestigationActionIdSha256) errors.push('The provider retrieval must be the first source investigation.')
      if (review?.taskRelevant !== true) errors.push('Task relevance is failed or unknown.')
      if (!['usable', 'empty', 'failed', 'unknown'].includes(review?.returnedEvidence)) errors.push('The retrieval evidence outcome must remain explicit.')
      if (needsOutput) { const returned = output?.actions?.find(item => item.idSha256 === action?.idSha256); if (!returned || returned.type !== 'mcp_tool_call' || returned.resultSha256 !== action?.resultSha256) errors.push('Cited returned evidence does not match the recorded MCP result hash.') }
      adoption = { required: true, attempted: Boolean(action && action.type === 'mcp_tool_call' && action.server === expected.server && action.tool === expected.tool), actionIdSha256: action?.idSha256 ?? null, returnedUsableEvidence: review?.returnedEvidence ?? 'unknown', providerError: action?.hasError ?? null }
    } else {
      if (review?.providerRetrievalActionIdSha256 != null) errors.push('Native control cannot claim a connected provider retrieval.')
      if (needsOutput) { const action = actions[investigationIndex], returned = output?.actions?.find(item => item.idSha256 === action?.idSha256); if (!returned || returned.type !== 'command_execution' || returned.outputSha256 !== action?.outputSha256) errors.push('Cited native evidence does not match its recorded output hash.') }
    }
    rows.push({ id: run.id, arm: run.arm, passed: errors.length === 0, instructionFollowed: review?.instructionFollowed ?? 'unknown', adoption, rationale: review?.rationale ?? null, limitations: review?.limitations ?? [], issues: errors })
    issues.push(...errors.map(error => `${run.id}: ${error}`))
  }
  return { complete: issues.length === 0, passed: issues.length === 0 && rows.length === 12, reviewer: audit.reviewer, auditReportSha256: audit.reportSha256, issues, runs: rows, limitation: 'Manual review must identify task relevance and ordering hidden within shell commands. Matching action IDs and hashes do not independently prove those semantic judgments. Failed retrieval attempts remain included and can be compliant; their costs and outcomes are not removed.' }
}
