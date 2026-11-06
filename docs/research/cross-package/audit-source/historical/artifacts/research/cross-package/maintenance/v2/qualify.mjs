import assert from 'node:assert/strict';
import {cpSync,mkdirSync,readFileSync,writeFileSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {captureAgent,invocation} from '../../../large-monorepo/inventory-agent-trial/capture.mjs';
import {initializeFixtureGit} from '../../../large-monorepo/agent-trial/fixture-git.mjs';
import {extractPairedEvents} from '../../../../../scripts/paired-agent-evidence.mjs';
import {inventoryTree} from '../../../../../scripts/paired-agent-integrity.mjs';
import {hash} from '../../../../../scripts/paired-agent-runner.mjs';
import {validationObservation} from '../../trial/run.mjs';
import {gradeWorkspace} from './grade.mjs';

const here=import.meta.dirname,maintenance=resolve(here,'..'),fixture=join(here,'fixture'),tracking=JSON.parse(readFileSync(join(fixture,'source-tracking-manifest.json'))),initial=JSON.parse(readFileSync(join(fixture,'initial-manifest.json')));
const save=(file,data)=>writeFileSync(join(here,file),JSON.stringify(data,null,2)+'\n',{mode:0o600});
const prompt='This is a validation-command transport preflight, not a coding task or benchmark score. Run exactly `npm run test:typelatch-benchmark` in the current workspace once. Wait for completion and briefly report its exit code. Do not edit files, investigate code, install anything, start network services, or run any other commands. Generated outputs produced by the supplied command are expected. Do not change permissions or execution settings if the command fails.';
const report={schemaVersion:1,startedAt:new Date().toISOString(),purpose:'Actual Codex workspace-write validation preflight; baseline and reference, no coding score.',fixtureSha256:initial.sha256,prompt,promptSha256:hash(prompt),runs:[],scope:{publicCases:9,privateCases:23,public:'Native TypeScript build and real production API/filesystem checks without a listening server.',private:'Twenty-two independent semantic checks plus the exact upstream catalog installation integration with a local registry outside the agent sandbox.'}};
save('qualification-in-progress.json',report);
const changed=['deps/status/src/checkDepsStatus.ts','lockfile/settings-checker/src/getOutdatedLockfileSetting.ts','lockfile/verification/src/index.ts','pkg-manager/core/src/install/index.ts'];
for(const name of ['baseline','reference']){
 const root=join(here,'private/preflight-001',name),workspace=join(root,'workspace'),state=join(root,'state');mkdirSync(state,{recursive:true});
 const start=performance.now();cpSync(join(fixture,'workspace'),workspace,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,mode:constants.COPYFILE_FICLONE_FORCE});
 if(name==='reference')for(const file of changed)writeFileSync(join(workspace,file),readFileSync(join(maintenance,'private/pnpm-catalogs/reference-files',file)));
 const before=inventoryTree(workspace),git=initializeFixtureGit({workspace,state,trackingManifest:tracking});
 const call=invocation({workspace,state,prompt,servers:{}});save(`private/preflight-001/${name}/invocation.json`,{command:call.command,args:call.args,config:call.config,environmentKeys:Object.keys(call.env)});
 const row={name,setupMs:performance.now()-start,git,startedAt:new Date().toISOString()};report.runs.push(row);save('qualification-in-progress.json',report);
 const result=await captureAgent({workspace,state,prompt,servers:{},output:join(root,'capture'),timeoutMs:240000}),events=extractPairedEvents(result.raw),observed=validationObservation(result.raw,9);
 row.capture={exitCode:result.exitCode,timedOut:result.timedOut,processGroupStopped:result.processGroupStopped,elapsedMs:result.elapsedMs,rawSha256:result.rawSha256,stderrSha256:result.stderrSha256,usage:events.usage,capture:events.capture,counts:events.counts};row.actions=events.actions;row.validation=observed;
 const after=inventoryTree(workspace),beforeMap=new Map(before.entries.map(e=>[e.path,e]));row.trackedSourcesUnchanged=tracking.entries.every(e=>JSON.stringify(beforeMap.get(e.path))===JSON.stringify(after.entries.find(x=>x.path===e.path)));
 row.publicPassed=observed.checks.length===1&&observed.checks[0].cases===9&&observed.checks[0].passed===(name==='reference')&&observed.checks[0].commandExitCode===(name==='reference'?0:1)&&events.counts.fileEdits===0&&events.counts.shellCalls===1&&result.exitCode===0&&result.processGroupStopped&&events.capture.complete&&row.trackedSourcesUnchanged;
 save('qualification-in-progress.json',report);
 row.privateGrade=await gradeWorkspace(workspace,initial);row.privateExpectedOutcome=row.privateGrade.passed===(name==='reference')&&row.privateGrade.integrity.passed===true&&row.privateGrade.checks?.cases===23;
 row.finishedAt=new Date().toISOString();save('qualification-in-progress.json',report);console.log(JSON.stringify({name,publicPassed:row.publicPassed,validation:observed,privatePassed:row.privateGrade.passed,privateExpectedOutcome:row.privateExpectedOutcome,capture:row.capture}));
 assert(row.publicPassed&&row.privateExpectedOutcome,`${name} qualification failed; retained outcomes`);
}
report.finishedAt=new Date().toISOString();report.status=report.runs.length===2&&report.runs.every(r=>r.publicPassed&&r.privateExpectedOutcome)?'qualified':'failed';save('qualification.json',report);
