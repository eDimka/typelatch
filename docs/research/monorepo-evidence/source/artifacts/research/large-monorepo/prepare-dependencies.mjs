import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createWriteStream,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
const base=import.meta.dirname,workspace=join(base,'pnpm-installed'),pnpm=join(base,'tools/pnpm/node_modules/pnpm/bin/pnpm.cjs')
const attempt=process.argv[2]??'001',allowCommittedHook=process.argv[3]==='--allow-committed-metadata-hook'
assert(/^[0-9]{3}$/.test(attempt))
const log=join(base,`dependency-install-${attempt}.log`),result=join(base,`dependency-install-${attempt}.json`)
assert(!existsSync(log)&&!existsSync(result),'Never overwrite a preparation attempt')
const hash=value=>createHash('sha256').update(value).digest('hex')
const protectedFiles=['pnpm-lock.yaml','pnpm-workspace.yaml','package.json','.pnpmfile.cjs']
const before=Object.fromEntries(protectedFiles.map(path=>[path,hash(readFileSync(join(workspace,path)))]))
const installHome=join(base,'install-home'),store=join(base,'pnpm-store')
mkdirSync(installHome,{recursive:true});mkdirSync(store,{recursive:true})
const config=join(installHome,'empty.npmrc');writeFileSync(config,'')
const args=[pnpm,'install','--frozen-lockfile','--ignore-scripts',...allowCommittedHook?[]:['--ignore-pnpmfile'],'--store-dir',store,'--config.enableGlobalVirtualStore=false','--config.managePackageManagerVersions=false','--filter=monorepo-root','--filter=@pnpm/env.system-node-version...','--filter=@pnpm/filter-workspace-packages...','--filter=@pnpm/plugin-commands-patching...','--reporter=append-only']
const start=performance.now(),createdAt=new Date().toISOString(),output=createWriteStream(log,{flags:'wx',mode:0o600})
writeFileSync(result,JSON.stringify({status:'running',createdAt,command:[process.execPath,...args],before},null,2)+'\n',{flag:'wx',mode:0o600})
const child=spawn(process.execPath,args,{cwd:workspace,env:{...process.env,HOME:installHome,XDG_CONFIG_HOME:join(installHome,'config'),XDG_CACHE_HOME:join(installHome,'cache'),npm_config_userconfig:config,CI:'1'},stdio:['ignore','pipe','pipe']})
child.stdout.on('data',bytes=>{output.write(bytes);process.stdout.write(bytes)})
child.stderr.on('data',bytes=>{output.write(bytes);process.stderr.write(bytes)})
const timeout=setTimeout(()=>child.kill('SIGTERM'),300000)
const ended=await new Promise(resolve=>{child.once('error',error=>resolve({exitCode:null,error:error.message}));child.once('exit',(exitCode,signal)=>resolve({exitCode,signal}))})
clearTimeout(timeout);await new Promise(resolve=>output.end(resolve))
const after=Object.fromEntries(protectedFiles.map(path=>[path,hash(readFileSync(join(workspace,path)))]))
const evidence={status:ended.exitCode===0?'completed':'failed',createdAt,completedAt:new Date().toISOString(),elapsedMs:performance.now()-start,...ended,command:[process.execPath,...args],before,after,protectedFilesUnchanged:JSON.stringify(before)===JSON.stringify(after),environment:{lifecycleScripts:false,pnpmfileHooks:allowCommittedHook,metadataHookDescription:allowCommittedHook?'The exact committed readPackage hook filters Linux optional @reflink/reflink binaries; required by the frozen lock checksum.':null,globalVirtualStore:false,isolatedStore:store,isolatedHome:installHome},logSha256:hash(readFileSync(log)),limitations:['This filtered install prepares selected leaf dependency closures and the root development toolchain, not every monorepo package.','No repository build or test script is run.']}
writeFileSync(result,JSON.stringify(evidence,null,2)+'\n',{mode:0o600})
console.log(JSON.stringify({status:evidence.status,elapsedMs:evidence.elapsedMs,protectedFilesUnchanged:evidence.protectedFilesUnchanged,result}))
process.exitCode=ended.exitCode??1
