import {relative,isAbsolute,resolve,dirname,join} from 'node:path';

const productionGlobs=['**/src/**/*.{ts,tsx,js,jsx,mjs,cjs}','!**/*.d.ts','!**/test/**','!**/tests/**','!**/__tests__/**','!**/fixtures/**'];
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const textOf=raw=>raw?.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')??(typeof raw==='string'?raw:JSON.stringify(raw??null));
const omitted=raw=>Boolean(raw?.omitted||raw?.truncated||raw?.declarations?.some(d=>d.omitted||d.truncated)||raw?.files?.some(d=>d.omitted||d.truncated));
const stop=new Set('locate production function finds show relevant implementation including handles checks whether each package packages workspace projects within family only strings represents distinguish parsing later graph filtering identify exact installed behind import version declaration file callable signature named type export called supplied current working tree what maximum bounds default combined available supporting constant evidence earlier session read list every directly source include site local renamed exclude tests docs declarations transitive guesses same spelled symbols different owning project configurations configuration explain settings references establish ownership do not substitute root nearest repository scope question compare internally actual edges report constructors constructor shape accepted use elsewhere sufficient select ambiguous least distinct request missing context rather silently selecting definition absent explicitly state similarly suggestions separate'.split(' '));

export function keywordPattern(question) {
  const words=[...new Set(question.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g)??[])].filter(x=>!stop.has(x));
  return words.sort((a,b)=>b.length-a.length).slice(0,2).map(escape).join('|');
}

export function importsOf(text) {
  const imports=[];
  for(const match of text.matchAll(/\bimport\s+([^;]*?)\s+from\s*['"]([^'"]+)['"]/g))imports.push({specifier:match[2],binding:match[1]});
  for(const match of text.matchAll(/(?:\brequire\s*\(|\bimport\s*\()\s*['"]([^'"]+)['"]/g))imports.push({specifier:match[1],binding:''});
  return [...new Map(imports.map(x=>[x.specifier,x])).values()];
}

export function returnedSources(raw,workspace) {
  const found=[];
  for(const item of raw?.files??[])if(item.path&&typeof item.text==='string')found.push({path:item.path,text:item.text,startLine:item.startLine??1,origin:'native-read'});
  const text=textOf(raw);
  for(const match of text.matchAll(/\*\*`([^`]+\.(?:tsx?|jsx?|mjs|cjs))`\*\*[^\n]*\n[\s\S]*?```[^\n]*\n([\s\S]*?)```/g))found.push({path:match[1],text:match[2].replace(/^\d+\t/gm,''),startLine:1,origin:'provider-source'});
  for(const match of text.matchAll(/\bsrc=([^\s\]]+\.(?:tsx?|jsx?|mjs|cjs))(?:\s+loc=L(\d+))?/g))found.push({path:match[1],startLine:Number(match[2]??1),origin:'provider-location'});
  for(const match of text.matchAll(/`([^`\n]+\.(?:tsx?|jsx?|mjs|cjs))`/g))found.push({path:match[1],startLine:1,origin:'provider-location'});
  const unique=new Map();
  for(const item of found){
    const path=isAbsolute(item.path)?relative(workspace,item.path):item.path.replace(/^\.\//,'');
    if(!unique.has(path)||(!unique.get(path).text&&item.text))unique.set(path,{...item,path});
  }
  return [...unique.values()].filter(x=>x.path&&!x.path.startsWith('../')&&!isAbsolute(x.path));
}

function inScope(path,context) {
  if(/(?:^|\/)(?:test|tests|__tests__|fixtures)\//.test(path)||/\.d\.ts$/.test(path))return false;
  if(!/(?:^|\/)src\//.test(path))return false;
  return !context.directories?.length||context.directories.some(d=>path.startsWith(d.replace(/\/$/,'')+'/'));
}

function packageDir(info,workspace) {
  const value=info?.package?.realPath??info?.package?.path;
  if(typeof value!=='string')return;
  const path=isAbsolute(value)?value:resolve(workspace,value);
  return path.endsWith('package.json')?dirname(path):path;
}

/** Routing only. Native and session methods own charging and raw action persistence. */
export async function collectProbe({provider,probe,session,workspace,native,budget={}}) {
  if(!['codegraph','graphify'].includes(provider))throw Error(`Unsupported provider ${provider}`);
  const context=probe.context??{}, evidence=[], limitations=[], notes=[];
  let actions=0,stopped=false;
  const maxActions=Math.min(8,budget.maxActions??budget.maximumRetrievalActionsPerProbe??8);
  async function invoke(kind,name,args) {
    if(stopped||actions>=maxActions){limitations.push('Action budget reached before further evidence could be collected.');return;}
    actions++;
    try {
      const raw=kind==='provider'?await session.call(name,args):await native[name](args);
      if(omitted(raw))limitations.push(`${kind}.${name} returned explicit omissions; omitted evidence is not treated as covered.`);
      evidence.push({kind,name,args,raw});return raw;
    }catch(error){limitations.push(`${kind}.${name}: ${String(error)}`);if(/budget|timeout|deadline|abort/i.test(String(error)))stopped=true;return;}
  }
  const read=files=>invoke('native','read',{files});
  const search=(pattern,extra={})=>invoke('native','search',{pattern,directories:context.directories,glob:productionGlobs,fixed:false,contextLines:8,...extra});
  async function graphQuery(query) {
    return provider==='codegraph'
      ?invoke('provider','codegraph_explore',{query,projectPath:workspace})
      :invoke('provider','query_graph',{question:query,depth:3,token_budget:4000});
  }
  async function packageEvidence(file,importSpecifier,includeDeclarations=true) {
    const info=await invoke('native','package',{file,importSpecifier,includeDeclarations});
    if(!info)return;
    const signature=probe.question.match(/callable\s+([\w$]+)\s+signature/i)?.[1];
    const namedType=probe.question.match(/named type export called\s+([\w$]+)/i)?.[1];
    const terms=[signature,namedType].filter(Boolean);
    const declarations=(info.declarations??[]).map(d=>d.text??'').join('\n');
    if(includeDeclarations&&terms.length&&(omitted(info)||terms.some(t=>!declarations.includes(t)))) {
      const dir=packageDir(info,workspace);
      if(dir)await search(terms.map(t=>'\\b'+escape(t)+'\\b').join('|'),{directories:[dir],glob:['**/*.d.ts','**/*.d.cts','**/*.d.mts'],contextLines:12});
      else limitations.push('Package response did not identify a directory for declaration follow-up.');
    }
    return info;
  }
  async function followConstantImports(sources) {
    for(const source of sources) {
      for(const item of importsOf(source.text??'')) {
        if(!item.specifier.startsWith('.')||!/[A-Z][A-Z0-9_]{3,}/.test(item.binding))continue;
        const info=await invoke('native','package',{file:source.path,importSpecifier:item.specifier,includeDeclarations:false});
        const path=info?.resolution?.resolvedFileName;
        if(path)await read([{path}]);
        if(actions>=maxActions)return;
      }
    }
  }

  if(probe.family==='ownership') {
    await invoke('native','configs',{files:context.files??[context.file].filter(Boolean)});
    notes.push('Ownership requires compiler configuration evidence; no graph substitution was made.');
  } else if(probe.family==='installed-api'&&context.file&&context.importSpecifier) {
    await packageEvidence(context.file,context.importSpecifier);
    notes.push('Installed package and declarations were resolved from the supplied importer.');
  } else if(probe.family==='installed-api'&&context.files?.length) {
    const initial=await read(context.files.map(path=>({path})));
    for(const source of initial?.files??[]) {
      const choices=importsOf(source.text??'').filter(x=>!x.specifier.startsWith('.')).map(item=>({
        ...item,score:probe.question.includes(item.specifier)?100:item.specifier.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2&&probe.question.toLowerCase().includes(w)).length+(item.binding.toLowerCase().includes('cache')&&probe.question.toLowerCase().includes('cache')?2:0),
      })).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
      if(!choices.length){limitations.push(`No query-related dependency import was discovered in ${source.path}.`);continue;}
      const chosen=choices[0];
      const dependency=await packageEvidence(source.path,chosen.specifier,true);
      if(!dependency)continue;
      // Follow runtime imports only when the question asks for an internal edge.
      if(!probe.question.includes(chosen.specifier)||!/(internally|internal|actual installed import edges)/i.test(probe.question))continue;
      const dir=packageDir(dependency,workspace);
      let entry=dependency.runtimePath?resolve(workspace,dependency.runtimePath):dependency.package?.main;
      if(!entry&&dir) {
        const manifest=await read([{path:join(dir,'package.json')}]);
        try{entry=JSON.parse(manifest?.files?.[0]?.text??'{}').main;}catch{limitations.push('Dependency manifest was incomplete or invalid JSON.');}
      }
      if(!entry&&dependency.resolution?.resolvedFileName&&!/\.d\.[cm]?ts$/.test(dependency.resolution.resolvedFileName))entry=dependency.resolution.resolvedFileName;
      if(!dir||!entry){limitations.push(`No runtime entrypoint was established for ${chosen.specifier}.`);continue;}
      const runtime=await read([{path:isAbsolute(entry)?entry:join(dir,entry)}]);
      for(const file of runtime?.files??[]) {
        const imports=importsOf(file.text??'').filter(x=>!x.specifier.startsWith('.')&&x.specifier.toLowerCase().split(/[^a-z0-9]+/).some(w=>w.length>2&&probe.question.toLowerCase().includes(w)));
        if(!imports.length)limitations.push(`No query-related runtime dependency edge was discovered in ${file.path}.`);
        for(const item of imports.slice(0,2))await packageEvidence(file.path,item.specifier,true);
      }
    }
  } else if(probe.family==='cross-package'&&context.packageName) {
    await invoke('native','manifests',{packageName:context.packageName});
    notes.push('Direct dependency declarations were enumerated from workspace manifests.');
  } else {
    const targets=[context.symbol,context.importSpecifier,...context.files??[],context.file].filter(Boolean);
    const query=targets.length?`${targets.join(' ')}\n${probe.question}`:probe.question;
    const first=await graphQuery(query);
    const allSources=returnedSources(first,workspace),sources=allSources.filter(x=>inScope(x.path,context));
    const outside=allSources.filter(x=>!inScope(x.path,context));
    if(outside.length)notes.push(`Provider locations outside requested production scope were retained as raw output but not selected for reads: ${outside.map(x=>x.path).join(', ')}`);
    if(probe.family==='negative') {
      await search('\\b'+escape(context.symbol)+'\\b');
      notes.push('Scoped exact-name search is required for coverage; a graph no-match alone does not establish absence.');
    } else if(probe.family==='cross-package'&&context.importSpecifier) {
      await search(context.importSpecifier,{fixed:true,contextLines:12});
      notes.push('Complete scoped import-site search supplements graph retrieval. Returned sites remain unclassified raw evidence.');
    } else {
      let selected=sources;
      if(!selected.length||probe.family==='ambiguity') {
        const pattern=context.symbol?'\\b'+escape(context.symbol)+'\\b':keywordPattern(probe.question);
        const result=pattern?await search(pattern):undefined;
        const matches=result?.matches??[];
        const firstMatches=new Map();
        for(const item of matches.filter(x=>(!x.kind||x.kind==='match')&&inScope(x.file,context))) {
          if(!firstMatches.has(item.file))firstMatches.set(item.file,{path:item.file,startLine:item.line??1,origin:'native-match'});
        }
        selected=[...firstMatches.values()];
        if(!pattern)limitations.push('No bounded fallback search terms could be derived from the public question.');
      }
      const needReads=selected.filter(item=>!item.text);
      const maxFiles=probe.family==='ambiguity'?2:4;
      if(needReads.length) {
        const result=await read(needReads.slice(0,maxFiles).map(({path,startLine})=>{const start=Math.max(1,(startLine??1)-12);return {path,startLine:start,endLine:start+239};}));
        const bodies=(result?.files??[]).map(x=>({...x,origin:'native-read'}));
        selected=[...selected.filter(x=>x.text),...bodies];
        if(needReads.length>maxFiles)limitations.push(`${needReads.length-maxFiles} returned candidate files were not read within the bounded collection policy.`);
      }
      if(probe.family==='freshness') {
        // A cached graph location is not current source evidence. The provider
        // may already return live source; otherwise the native read above does.
        await followConstantImports(selected);
        notes.push('Freshness collection used this invocation\'s provider source or live native reads. Coordinator owns mutation, grace and refresh timing.');
      }
      if(!selected.length)limitations.push('No in-scope implementation body was collected.');
    }
  }
  return {provider,probeId:probe.id,evidence,limitations:[...new Set(limitations)],notes,attemptedActions:actions,budgetAuthority:'Caller wrappers charge every provider and native action; collector does not alter budget or raw responses.'};
}
