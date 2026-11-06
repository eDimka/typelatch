import test from 'node:test'
import assert from 'node:assert/strict'
import { constants, cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gradeWorkspace } from './development/grader.mjs'
test('full development fixture accepts only the answer and rejects source changes',()=>{
 const base=resolve('artifacts/research/cross-package/impact'),descriptor=JSON.parse(readFileSync(join(base,'development/descriptor.json'))),temp=mkdtempSync(join(tmpdir(),'typelatch-impact-integrity-')),workspace=join(temp,'workspace'),initial=JSON.parse(readFileSync(descriptor.initialManifest))
 try{
  cpSync(descriptor.workspace,workspace,{recursive:true,dereference:false,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE_FORCE})
  assert.equal(gradeWorkspace(workspace,initial).passed,false)
  writeFileSync(join(workspace,descriptor.answerFile),readFileSync(join(base,'development/gold-answer.json')))
  assert.equal(gradeWorkspace(workspace,initial).passed,true)
  const source=join(workspace,'packages/parse-wanted-dependency/src/index.ts'),original=readFileSync(source)
  writeFileSync(source,Buffer.concat([original,Buffer.from('\n// changed\n')]))
  const changed=gradeWorkspace(workspace,initial);assert.equal(changed.passed,false);assert(changed.integrity.changed.includes('packages/parse-wanted-dependency/src/index.ts'))
  assert.equal(readFileSync(join(descriptor.workspace,'packages/parse-wanted-dependency/src/index.ts')).equals(original),true)
 }finally{rmSync(temp,{recursive:true,force:true})}
})
