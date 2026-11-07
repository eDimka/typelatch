import test from 'node:test'
import assert from 'node:assert/strict'
import { constants,cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { tmpdir } from 'node:os'
import { gradeAnswer } from '../grading-v2/grade-answer.mjs'
const base=resolve('artifacts/research/cross-package/impact/private')
for(const id of ['heldout-grading-v2','heldout-runtime-grading-v2'])test(`${id}: unchanged case qualifies under prospective generic grading`,async()=>{
 const folder=join(base,id),descriptor=JSON.parse(readFileSync(join(folder,'descriptor.json'))),truth=JSON.parse(readFileSync(join(folder,'truth.json'))),gold=JSON.parse(readFileSync(join(folder,'gold-answer.json'))),initial=JSON.parse(readFileSync(descriptor.initialManifest)),{gradeWorkspace}=await import(descriptor.graderModule)
 assert.equal(gradeAnswer(descriptor.workspace,gold,truth).passed,true)
 const wrong=structuredClone(gold);wrong.uncertainties[0].state='proven-unaffected';assert.equal(gradeAnswer(descriptor.workspace,wrong,truth).passed,false)
 const omitted=structuredClone(gold);omitted.direct.pop();assert.equal(gradeAnswer(descriptor.workspace,omitted,truth).passed,false)
 const temp=mkdtempSync(join(tmpdir(),'impact-v2-private-')),workspace=join(temp,'workspace')
 try {
  cpSync(descriptor.workspace,workspace,{recursive:true,dereference:false,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE_FORCE})
  writeFileSync(join(workspace,'impact-answer.json'),JSON.stringify(gold));assert.equal(gradeWorkspace(workspace,initial).passed,true)
  const file=gold.direct[0].file,source=join(workspace,file),original=readFileSync(source)
  writeFileSync(source,Buffer.concat([original,Buffer.from('\n// mutation\n')]));const changed=gradeWorkspace(workspace,initial);assert.equal(changed.passed,false);assert(changed.integrity.changed.includes(file));assert(readFileSync(join(descriptor.workspace,file)).equals(original))
 }finally{rmSync(temp,{recursive:true,force:true})}
})
