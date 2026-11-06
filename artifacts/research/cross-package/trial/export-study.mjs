import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {homedir,tmpdir} from 'node:os'
import {hash} from '../../../../scripts/paired-agent-runner.mjs'
import {normalizeDemo} from '../../../../scripts/demo-evidence.mjs'
import {adjudicate} from './review.mjs'
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
const replacements=[[study,'$STUDY'],[repository,'$REPOSITORY'],[homedir(),'$USER_HOME'],[tmpdir().replace(/\/$/u,''),'$TEMP']]
const manifest={schemaVersion:1,privateReportSha256:hash(reportBytes),privateProtocolSha256:hash(protocolBytes),originalResultsUnchanged:true,createdAt:new Date().toISOString(),normalization:'Private report and review files have local path placeholders. Hashes retain original byte identities; completed public action records and tool outputs are copied exactly. No model reasoning or assistant message bodies are included.',files:[]}
mkdirSync(output,{recursive:true})
function save(name,bytes,originalSha256){const full=join(output,name);assert(!/\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u.test(bytes.toString()),`Unnormalized path in ${name}`);mkdirSync(resolve(full,'..'),{recursive:true});writeFileSync(full,bytes,{flag:'wx'});manifest.files.push({path:name,sha256:hash(bytes),originalSha256:originalSha256??hash(bytes),bytes:Buffer.byteLength(bytes)})}
function normalized(name,bytes){save(name,JSON.stringify(normalizeDemo(JSON.parse(bytes),replacements),null,2)+'\n',hash(bytes))}
normalized('report.json',reportBytes)
normalized('workflow-audit.json',auditBytes)
for(const name of ['adjudicated-result.json','correctness-audit.json'])normalized(name,readFileSync(join(study,name)))
const explanation=readFileSync(join(study,'correctness-audit.md'),'utf8');save('correctness-audit.md',normalizeDemo(explanation,replacements),hash(explanation))
for(const row of report.runs){save(`runs/${row.id}/public-evidence.json`,records.get(row.id));save(`runs/${row.id}/tool-outputs.json`,outputs.get(row.id))}
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({output,files:manifest.files.length,privateReportSha256:manifest.privateReportSha256,anyQualifiedEdge:decision.decision.anyQualifiedEdge}))
