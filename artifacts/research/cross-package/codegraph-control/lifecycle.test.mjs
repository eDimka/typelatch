import test from 'node:test';
import assert from 'node:assert/strict';
import {runSetupCommand,serverSpec} from './lifecycle.mjs';

test('timed out setup stops an inherited descendant group after the direct child exits',async()=>{
 const code="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)",spec={command:process.execPath,cwd:process.cwd(),env:process.env};
 const result=await runSetupCommand(spec,['-e',code],300);
 try{assert.equal(result.timedOut,true);assert.equal(result.processGroupStopped,true);assert.throws(()=>process.kill(-result.pid,0),{code:'ESRCH'});}finally{try{process.kill(-result.pid,'SIGKILL');}catch{}}
});
test('frozen launch exposes all tools and disables download fallback',()=>{const spec=serverSpec({workspace:'/scratch/workspace',state:'/scratch/state'});assert.equal(spec.tools.length,8);assert.equal(spec.env.CODEGRAPH_NO_DOWNLOAD,'1');assert.equal(spec.env.HOME,'/scratch/state/codegraph/home');assert(spec.command.endsWith('/codegraph-darwin-arm64/bin/codegraph'));});
