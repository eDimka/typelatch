const {createRequire}=require('node:module');
const {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,constants}=require('node:fs');
const {join,dirname}=require('node:path');
const {tmpdir}=require('node:os');
const {spawn}=require('node:child_process');
const net=require('node:net');

module.exports=async()=>{
  const req=createRequire(join(process.cwd(),'package.json'));
  const mockRoot=dirname(req.resolve('@pnpm/registry-mock/package.json'));
  const mockRequire=createRequire(join(mockRoot,'package.json'));
  const yaml=req('yaml');
  const scratch=mkdtempSync(join(tmpdir(),'typelatch-native-registry-'));
  const storage=join(scratch,'storage');
  cpSync(join(mockRoot,'registry/storage-cache'),storage,{recursive:true,dereference:false,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE_FORCE});
  const metadata=JSON.parse(readFileSync(process.env.TYPELATCH_REGISTRY_METADATA||join(__dirname,'registry-is-positive.json'),'utf8'));
  mkdirSync(join(storage,'is-positive'),{recursive:true});
  writeFileSync(join(storage,'is-positive/package.json'),JSON.stringify({...metadata,_uplinks:{},_distfiles:{},_attachments:{},_rev:'1-native-regression-seed'}));
  const config=yaml.parse(readFileSync(join(mockRoot,'registry/config.yaml'),'utf8'));
  writeFileSync(join(scratch,'config.yaml'),JSON.stringify({...config,storage,auth:{},middlewares:{},uplinks:{npmjs:{url:'http://127.0.0.1:9/',timeout:'1s',max_fails:0}}},null,2));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  process.env.PNPM_REGISTRY_MOCK_PORT=String(port);
  const registryNode=process.env.TYPELATCH_REGISTRY_NODE||join(__dirname,'node20');
  const child=spawn(registryNode,[mockRequire.resolve('verdaccio/bin/verdaccio'),'--config',join(scratch,'config.yaml'),'--listen',String(port)],{stdio:['ignore','pipe','pipe'],env:process.env});
  let stderr='';child.stderr.on('data',x=>stderr+=x);child.stdout.on('data',x=>stderr+=x);
  global.killServer=async()=>{if(child.exitCode===null){const done=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await done;}};
  const start=Date.now();let observation='No response';
  while(Date.now()-start<15000){
    if(child.exitCode!==null)throw Error('Registry exited: '+stderr);
    try{const response=await fetch('http://localhost:'+port+'/is-positive');if(response.ok)return;observation=response.status+':'+await response.text();}catch(error){observation=String(error?.cause??error);}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await global.killServer();throw Error('Registry readiness timeout: '+observation+' '+stderr);
};
