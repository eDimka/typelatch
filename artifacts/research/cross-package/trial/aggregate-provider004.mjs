import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
const base=resolve(import.meta.dirname,'..'),read=path=>JSON.parse(readFileSync(path)),hash=x=>createHash('sha256').update(x).digest('hex')
const targetPath=join(base,'provider-spec-004.json'),oldPath=join(base,'provider-spec-002.json'),target=read(targetPath),old=read(oldPath)
const oldReceipt=join(base,'provider-qualification-002/report.json'),newReceipt=join(base,'codegraph-control/qualification-001/report.json'),a=read(oldReceipt),b=read(newReceipt)
assert(a.passed&&b.passed);assert.equal(a.specSha256,hash(readFileSync(oldPath)));assert.equal(a.captureSha256,b.captureSha256)
for(const arm of ['native','impact','competitor'])assert.deepEqual(target.arms[arm],old.arms[arm])
assert.deepEqual(target.arms.codegraph.servers,b.servers)
const selection=read(resolve(base,'../../../docs/research/cross-package/confirmation-candidate.json'))
assert.equal(selection.armSha256,hash(JSON.stringify(target.arms.impact)))
const inputs=new Map()
for(const row of [...a.implementationInputs,...b.implementationInputs]){assert.equal(hash(readFileSync(row.path)),row.sha256);if(inputs.has(row.path))assert.equal(inputs.get(row.path).sha256,row.sha256);inputs.set(row.path,row)}
const runs=[...a.runs,...b.runs];assert.deepEqual(runs.map(r=>r.arm).toSorted(),['impact','competitor','codegraph'].toSorted())
for(const row of runs){assert.equal(row.status,'passed');assert.equal(row.cleanup.stopped,true);assert.equal(row.capture.capture.complete,true);assert(row.proof.some(p=>p.markerObserved))}
const output=join(base,'provider-qualification-004');mkdirSync(output)
const report={schemaVersion:1,purpose:'Aggregate existing independent actual Codex transport proofs for byte-identical provider definitions. This assembly does not rerun or relabel the older qualification sessions.',createdAt:new Date().toISOString(),specSha256:hash(readFileSync(targetPath)),captureSha256:a.captureSha256,passed:true,implementationInputs:[...inputs.values()],sources:[{arms:['impact','competitor'],spec:oldPath,specSha256:a.specSha256,receipt:oldReceipt,receiptSha256:hash(readFileSync(oldReceipt)),completedAt:a.completedAt},{arms:['codegraph'],receipt:newReceipt,receiptSha256:hash(readFileSync(newReceipt)),completedAt:b.completedAt,serversSha256:hash(JSON.stringify(b.servers))}],runs}
writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({passed:true,receipt:join(output,'report.json'),arms:runs.map(r=>r.arm)}))
