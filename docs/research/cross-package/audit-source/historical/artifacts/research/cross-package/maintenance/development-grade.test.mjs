import test from 'node:test';
import assert from 'node:assert/strict';
import {integrity} from './development-grade.mjs';
const file=(path,sha256='original',mode=0o644)=>({path,kind:'file',mode,sha256,bytes:10});
const entries=[file('leaf/src/index.ts'),file('leaf/src/index.test.ts'),file('leaf/package.json'),file('leaf/tsconfig.json'),file('leaf/node_modules/dependency/index.js'),file('.typelatch-benchmark/semantic-check.mjs')];
const initial={entries},tracking={entries:entries.filter(row=>!row.path.includes('node_modules'))};
const changed=path=>({entries:entries.map(row=>row.path===path?{...row,sha256:'changed'}:row)});
test('existing production TypeScript may change',()=>assert.equal(integrity(initial,changed('leaf/src/index.ts'),tracking).passed,true));
test('tests, dependencies, manifests and public validation remain protected',()=>{for(const path of entries.map(x=>x.path).filter(x=>x!=='leaf/src/index.ts'))assert.equal(integrity(initial,changed(path),tracking).passed,false,path);});
test('new or deleted source files and executable-bit edits are rejected',()=>{
  assert.equal(integrity(initial,{entries:[...entries,file('leaf/src/new.ts')]},tracking).passed,false);
  assert.equal(integrity(initial,{entries:entries.filter(x=>x.path!=='leaf/src/index.ts')},tracking).passed,false);
  assert.equal(integrity(initial,{entries:entries.map(x=>x.path==='leaf/src/index.ts'?{...x,mode:0o755}:x)},tracking).passed,false);
});
test('compiler outputs are disposable only under declared projects',()=>{
  const result=integrity(initial,{entries:[...entries,file('leaf/lib/index.js')]},tracking);assert.equal(result.passed,true);assert.deepEqual(result.generatedChanged,['leaf/lib/index.js']);assert.deepEqual(result.changed,[]);
  for(const path of ['unrelated/lib/index.js','leaf/node_modules/dependency/lib/index.js'])assert.equal(integrity(initial,{entries:[...entries,file(path)]},tracking).passed,false,path);
});
test('a source symlink cannot replace a protected regular file',()=>assert.equal(integrity(initial,{entries:entries.map(x=>x.path==='leaf/src/index.ts'?{path:x.path,kind:'symlink',mode:0o777,target:'../../../answer.ts',sha256:'link'}:x)},tracking).passed,false));
test('upstream test infrastructure source is immutable',()=>{
  for(const path of ['__utils__/prepare/src/index.ts','testing/temp-store/src/index.ts','leaf/src/test-utils.ts']){
    const original=file(path),snapshot={entries:[...entries,original]},tracked={entries:[...tracking.entries,original]};
    assert.equal(integrity(snapshot,{entries:[...entries,{...original,sha256:'tampered'}]},tracked).passed,false,path);
  }
});
