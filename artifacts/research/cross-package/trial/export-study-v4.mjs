import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {homedir,tmpdir} from 'node:os'
import {hash} from '../../../../scripts/paired-agent-runner.mjs'
import {normalizeDemo} from '../../../../scripts/demo-evidence.mjs'
import {adjudicate} from './review.mjs'
import {adjudicateCodegraph} from './codegraph-challenge.mjs'
const [studyArgument,outputArgument]=process.argv.slice(2)
assert(studyArgument&&outputArgument,'Use STUDY_DIRECTORY NEW_EXPORT_DIRECTORY')
const study=resolve(studyArgument),output=resolve(outputArgument),repository=resolve(import.meta.dirname,'../../../..')
assert(!existsSync(output),'Never overwrite exported evidence')
const reportBytes=readFileSync(join(study,'report-private.json')),report=JSON.parse(reportBytes)
assert.equal(report.complete,true)
const protocolBytes=readFileSync(join(study,'protocol.json')),auditBytes=readFileSync(join(study,'workflow-audit.json')),audit=JSON.parse(auditBytes)
const records=new Map(),outputs=new Map()
for(const row of report.runs){records.set(row.id,readFileSync(join(study,'runs',row.id,'public-evidence.json')));outputs.set(row.id,readFileSync(join(study,'runs',row.id,'tool-outputs.json')))}
const decision=adjudicate({reportBytes,protocolBytes,audit,records,outputs})
assert.deepEqual(decision,JSON.parse(readFileSync(join(study,'adjudicated-result.json'))))
const evaluatorFiles=['decision.mjs','review.mjs','codegraph-challenge.mjs']
for(const name of evaluatorFiles){const path=join(import.meta.dirname,name);assert(JSON.parse(protocolBytes).inputs.some(row=>row.path===path&&row.kind==='file'&&row.sha256===hash(readFileSync(path))),'Evaluator source must match the frozen protocol')}
const challenge=adjudicateCodegraph({reportBytes,protocolBytes,audit,records,outputs})
assert.deepEqual(challenge,JSON.parse(readFileSync(join(study,'codegraph-challenge.json'))))
const policyBytes=readFileSync(join(import.meta.dirname,'codegraph-challenge-policy.json'));assert.equal(hash(policyBytes),challenge.policySha256)
const replacements=[[study,'$STUDY'],[repository,'$REPOSITORY'],[homedir(),'$USER_HOME'],[tmpdir().replace(/\/$/u,''),'$TEMP']]
const manifest={schemaVersion:1,privateReportSha256:hash(reportBytes),privateProtocolSha256:hash(protocolBytes),originalResultsUnchanged:true,auditHashEncoding:'adjudicated-result.auditSha256 hashes JSON.stringify of the parsed original audit; manifest hashes bind exact file bytes.',originalParsedAuditSha256:hash(JSON.stringify(audit)),publicParsedAuditSha256:hash(JSON.stringify(normalizeDemo(audit,replacements))),createdAt:new Date().toISOString(),normalization:'Private report and review files have local path placeholders. Hashes retain original byte identities; completed public action records and tool outputs are copied exactly. No model reasoning or assistant message bodies are included.',files:[]}
mkdirSync(output,{recursive:true})
function save(name,bytes,originalSha256){const full=join(output,name);assert(!/\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u.test(bytes.toString()),`Unnormalized path in ${name}`);mkdirSync(resolve(full,'..'),{recursive:true});writeFileSync(full,bytes,{flag:'wx'});manifest.files.push({path:name,sha256:hash(bytes),originalSha256:originalSha256??hash(bytes),bytes:Buffer.byteLength(bytes)})}
function normalized(name,bytes){save(name,JSON.stringify(normalizeDemo(JSON.parse(bytes),replacements),null,2)+'\n',hash(bytes))}
normalized('report.json',reportBytes)
normalized('workflow-audit.json',auditBytes)
normalized('adjudicated-result.json',readFileSync(join(study,'adjudicated-result.json')))
normalized('codegraph-challenge.json',readFileSync(join(study,'codegraph-challenge.json')))
save('codegraph-challenge-policy.json',policyBytes)
for(const name of evaluatorFiles)save('evaluator/'+name,readFileSync(join(import.meta.dirname,name)))
for(const stem of ['correctness-audit','native-validation-audit','control-audit']){
 const json=join(study,stem+'.json'),markdown=join(study,stem+'.md')
 if(existsSync(json))normalized(stem+'.json',readFileSync(json))
 if(existsSync(markdown)){const text=readFileSync(markdown,'utf8');save(stem+'.md',normalizeDemo(text,replacements),hash(text))}
}
for(const row of report.runs){
 save(`runs/${row.id}/public-evidence.json`,records.get(row.id));save(`runs/${row.id}/tool-outputs.json`,outputs.get(row.id))
 const copy=readFileSync(join(study,'runs',row.id,'fixture-copy.json'))
 assert.equal(hash(copy),row.fixtureCopy.sha256,'Copy receipt must match its recorded identity')
 assert.deepEqual(JSON.parse(records.get(row.id)).run.fixtureCopy,row.fixtureCopy,'Recorded copy metadata must agree')
 for(const name of ['fixture-copy.json','fixture-git.json','preparation.json','cleanup.json'])normalized(`runs/${row.id}/${name}`,readFileSync(join(study,'runs',row.id,name)))
}
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({output,files:manifest.files.length,privateReportSha256:manifest.privateReportSha256,qualifiedAcrossMeasuredControls:challenge.qualifiedAcrossMeasuredControls}))
