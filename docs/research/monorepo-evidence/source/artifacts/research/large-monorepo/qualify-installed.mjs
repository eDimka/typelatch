import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {existsSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
const base=import.meta.dirname,workspace=join(base,'pnpm-installed'),require=createRequire(join(workspace,'package.json'))
const ts=require('typescript')
assert.equal(ts.version,'5.5.4')
const hash=value=>createHash('sha256').update(value).digest('hex')
const cases=[{file:'env/system-node-version/src/index.ts',specifier:'execa',expectedName:'safe-execa',expectedVersion:'0.1.2'},{file:'patching/plugin-commands-patching/src/patchCommit.ts',specifier:'safe-execa',expectedName:'safe-execa',expectedVersion:'0.1.4'},{file:'resolving/npm-resolver/src/index.ts',specifier:'lru-cache',expectedName:'lru-cache',expectedVersion:'10.4.3'}]
const rows=[]
for(const item of cases){
 const file=join(workspace,item.file),config=ts.findConfigFile(dirname(file),ts.sys.fileExists)
 assert(config)
 const parsed=ts.getParsedCommandLineOfConfigFile(config,{}, {...ts.sys,onUnRecoverableConfigFileDiagnostic:diagnostic=>{throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n'))}})
 assert(parsed&&parsed.errors.length===0)
 assert(parsed.fileNames.includes(file),'Consumer must belong to the actual selected config')
 const resolution=ts.resolveModuleName(item.specifier,file,parsed.options,ts.sys).resolvedModule
 assert(resolution,'Installed API must resolve through repository TypeScript')
 let directory=dirname(realpathSync(resolution.resolvedFileName)),manifest
 while(directory!==dirname(directory)){const path=join(directory,'package.json');if(existsSync(path)){const candidate=JSON.parse(readFileSync(path));if(candidate.name===item.expectedName){manifest={path,...candidate};break}}directory=dirname(directory)}
 assert(manifest)
 assert.equal(manifest.version,item.expectedVersion)
 const program=ts.createProgram({rootNames:[file],options:parsed.options,projectReferences:parsed.projectReferences}),checker=program.getTypeChecker(),source=program.getSourceFile(file)
 const declaration=source.statements.find(node=>ts.isImportDeclaration(node)&&node.moduleSpecifier.text===item.specifier)
 assert(declaration)
 const moduleSymbol=checker.getSymbolAtLocation(declaration.moduleSpecifier)
 assert(moduleSymbol)
 const exports=checker.getExportsOfModule(moduleSymbol).map(symbol=>symbol.name).sort()
 const binding=declaration.importClause?.name??declaration.importClause?.namedBindings
 const type=binding?checker.getTypeAtLocation(binding):null
 const text=readFileSync(resolution.resolvedFileName)
 rows.push({file:item.file,config:config.slice(workspace.length+1),specifier:item.specifier,packageName:manifest.name,version:manifest.version,packageRoot:dirname(manifest.path),packageManifestSha256:hash(readFileSync(manifest.path)),resolvedDeclaration:resolution.resolvedFileName,declarationSha256:hash(text),declarationBytes:text.length,compilerPackageId:resolution.packageId??null,exports,bindingType:type?checker.typeToString(type,undefined,ts.TypeFormatFlags.NoTruncation):null,callSignatures:type?checker.getSignaturesOfType(type,ts.SignatureKind.Call).map(signature=>checker.signatureToString(signature,undefined,ts.TypeFormatFlags.NoTruncation)):[]})
}
const sourceInventory=JSON.parse(readFileSync(join(base,'corpus-inventory.json')))
const changed=sourceInventory.entries.filter(item=>item.kind==='file').filter(item=>!existsSync(join(workspace,item.path))||hash(readFileSync(join(workspace,item.path)))!==item.sha256).map(item=>item.path)
assert.deepEqual(changed,[],'Dependency preparation must leave all committed file bytes unchanged')
const evidence={schemaVersion:1,checkedAt:new Date().toISOString(),typescriptVersion:ts.version,nodeVersion:process.version,sourceFilesUnchanged:true,rows,limits:['This checks exact installed external package resolution under existing owning project configs.','Workspace packages have not been built; this is not a whole-monorepo compiler or test success claim.','Different package versions do not by themselves establish different behavior or signatures.']}
writeFileSync(join(base,'installed-qualification.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({typescriptVersion:ts.version,sourceFilesUnchanged:true,rows:rows.map(({file,config,specifier,packageName,version,declarationSha256,exports,callSignatures})=>({file,config,specifier,packageName,version,declarationSha256,exports,callSignatures:callSignatures.length}))},null,2))
