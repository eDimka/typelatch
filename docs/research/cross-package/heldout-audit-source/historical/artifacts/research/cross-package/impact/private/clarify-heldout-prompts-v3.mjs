import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const base = resolve(import.meta.dirname)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const encode = value => JSON.stringify(value, null, 2) + '\n'
const cases = [
  ['heldout-grading-v2', 'heldout-prompt-v3', [
    ['Explicitly state limits for external consumers, computed loading, package reachability and unexecuted validation.', 'Represent the limits for external consumers, computed loading, package reachability and unexecuted validation using the four uncertainty code/state pairs specified below. Do not add prose fields.'],
  ]],
  ['heldout-runtime-grading-v2', 'heldout-runtime-prompt-v3', [
    ['Explain this boundary under dynamic-loading.', 'Represent this boundary using the dynamic-loading unknown state specified below; do not add prose fields.'],
    ['Also state limits for external consumers, package reachability and unexecuted validation.', 'Represent the limits for external consumers, package reachability and unexecuted validation using the uncertainty code/state pairs specified below. Do not add prose fields.'],
  ]],
]
const receipts = []
for (const [oldName, newName, replacements] of cases) {
  const source = join(base, oldName), destination = join(base, newName)
  assert(!existsSync(destination), 'Do not overwrite a prior task version')
  const descriptorBytes = readFileSync(join(source, 'descriptor.json')), promptBytes = readFileSync(join(source, 'prompt.txt'))
  const descriptor = JSON.parse(descriptorBytes), qualification = JSON.parse(readFileSync(descriptor.qualification))
  assert.equal(promptBytes.toString().trimEnd(), descriptor.description.trimEnd())
  const previous = structuredClone(descriptor)
  for (const [before, after] of replacements) {
    assert.equal(descriptor.description.split(before).length, 2, 'Replace exactly one conflicting instruction')
    descriptor.description = descriptor.description.replace(before, after)
  }
  assert(!descriptor.description.includes('Explain this boundary under dynamic-loading.'))
  assert(descriptor.description.includes('Do not add freeform uncertainty prose or undocumented answer fields.'))
  descriptor.promptVersion = 3
  descriptor.previousDescriptor = join(source, 'descriptor.json')
  descriptor.qualification = join(destination, 'qualification.json')
  for (const key of ['workspace', 'initialManifest', 'sourceTrackingManifest', 'graderModule', 'answerFile', 'scope', 'publicCases', 'gradingVersion']) assert.deepEqual(descriptor[key], previous[key], 'Prompt clarification cannot change source, grade, scope or schema')
  mkdirSync(destination)
  writeFileSync(join(destination, 'descriptor.json'), encode(descriptor))
  writeFileSync(join(destination, 'prompt.txt'), descriptor.description + '\n')
  writeFileSync(join(destination, 'qualification.json'), encode({
    ...qualification, previousQualification: previous.qualification,
    promptOnlyClarification: true, qualificationInheritedFromUnchangedFixtureAndGrader: true,
    amendment: join(base, 'prompt-amendment-v3.json'), newModelSessions: 0,
  }))
  assert.equal(hash(readFileSync(join(source, 'descriptor.json'))), hash(descriptorBytes))
  assert.equal(hash(readFileSync(join(source, 'prompt.txt'))), hash(promptBytes))
  receipts.push({ id: descriptor.id, previousDescriptor: join(source, 'descriptor.json'), descriptor: join(destination, 'descriptor.json'),
    previousDescriptorSha256: hash(descriptorBytes), descriptorSha256: hash(readFileSync(join(destination, 'descriptor.json'))),
    previousPromptSha256: hash(promptBytes), promptSha256: hash(readFileSync(join(destination, 'prompt.txt'))), replacements,
    graderModule: descriptor.graderModule, graderSha256: hash(readFileSync(descriptor.graderModule)),
    truthSha256: qualification.truthSha256, schemaSha256: hash(readFileSync(descriptor.publicCases.answerSchema)),
    sourceFixtureUnchanged: true, expectedSetsUnchanged: true,
  })
}
writeFileSync(join(base, 'prompt-amendment-v3.json'), encode({schemaVersion:1,reason:'Pretrial independent review found prose instructions incompatible with the frozen schema2 uncertainty states.',candidateFrozenBeforeReview:'aabf5c3',originalFilesUnchanged:true,newModelSessions:0,cases:receipts}))
const old = JSON.parse(readFileSync(join(base, 'confirmation-freeze-inputs.json')))
const additions = ['confirmation-freeze-inputs.json', 'heldout/grader.mjs', 'heldout-runtime-v1/grader.mjs', 'clarify-heldout-prompts-v3.mjs', 'prompt-amendment-v3.json', ...cases.flatMap(([,name]) => ['descriptor.json', 'prompt.txt', 'qualification.json'].map(file => `${name}/${file}`))]
const result = {...old, descriptors: receipts.map(row => row.descriptor), files: [...old.files, ...additions.map(file=>({path:join(base,file),kind:'file'}))], promptClarification:'prompt-amendment-v3.json'}
writeFileSync(join(base, 'confirmation-freeze-inputs-v3.json'), encode(result))
console.log(JSON.stringify({descriptors:result.descriptors,files:result.files.length,allPriorInputsUnchanged:true}))
