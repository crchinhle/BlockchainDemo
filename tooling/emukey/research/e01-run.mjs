import {readFile,writeFile,mkdir,readdir,open,cp,access} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const out=resolve(process.argv[2]??resolve(repo,'EmuKey/backend/.research-local/evidence/EmuKey_E01_'+new Date().toISOString().replace(/[:.]/g,'-')));
await mkdir(out,{recursive:true});for(const d of ['raw','scripts','tables','figures'])await mkdir(resolve(out,d),{recursive:true});
const exists=p=>access(p).then(()=>true,()=>false),hash=b=>createHash('sha256').update(b).digest('hex');
const lock=resolve(out,'runner.lock');if(await exists(lock)){const old=JSON.parse(await readFile(lock));try{process.kill(old.pid,0);throw new Error('E01_ALREADY_RUNNING:'+old.pid);}catch(e){if(e.code!=='ESRCH')throw e;}await import('node:fs/promises').then(f=>f.rename(lock,lock+'.interrupted-'+Date.now()));}
await writeFile(lock,JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'});
const manifestPath=resolve(out,'manifest.json'),sourcePaths=['EmuKey/backend/src/modules/research/protocol-v2.ts','EmuKey/backend/src/modules/research/http-benchmark.ts','tooling/emukey/research/http-load.mjs','tooling/emukey/research/e01-revocation.mjs','tooling/emukey/research/e01-run.mjs'];
const sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,hash(await readFile(resolve(repo,p)))])));
let m=await exists(manifestPath)?JSON.parse(await readFile(manifestPath)):{id:out.split(/[\\/]/).at(-1),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),createdAt:new Date().toISOString(),host:{cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,memoryBytes:os.totalmem(),platform:os.platform(),release:os.release(),node:process.version},sourceHashes,attempts:[],plan:{hybrid:135,direct:45,revocation:90,seeds:[4101,4102,4103,4104,4105],cacheMs:[1000,2000,5000],tokenMs:[800,1000,2000],rates:[25,50,100]},environmentDifferences:['New local chain instance','Same trace implementation across all E01 runs','No host resource isolation','DIRECT_ONCHAIN snapshot validity fixed at 5000ms; no cache; existing deadline rule retained','HTTP has no background synchronization; revocation measured separately with isolated probes']};
if(JSON.stringify(m.sourceHashes)!==JSON.stringify(sourceHashes))throw new Error('SOURCE_CHANGED_USE_NEW_CAMPAIGN');
async function save(){const temp=manifestPath+'.tmp';await writeFile(temp,JSON.stringify(m,null,2));await import('node:fs/promises').then(f=>f.rename(temp,manifestPath));}
await save();console.log('E01',out);
await writeFile(resolve(out,'scripts/source.patch'),execFileSync('git',['diff','--','EmuKey/backend/src/modules/research/protocol-v2.ts','EmuKey/backend/src/modules/research/http-benchmark.ts','tooling/emukey/research/http-load.mjs'],{cwd:repo}));
const allRows=async folder=>{let rr=[];for(const n of await readdir(folder))if(n.endsWith('.ndjson'))rr.push(...(await readFile(resolve(folder,n),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse));return rr;};
async function validate(entry){try{
 const rr=await allRows(resolve(out,entry.path));const ends=rr.filter(x=>x.type==='end');if(ends.length!==1||ends[0].state!=='COMPLETED')return {valid:false,reason:'missing successful end'};
 if(entry.group==='http'){
  const s=rr.filter(x=>x.type==='sample'),expected=entry.config.rate*entry.config.durationMs/1000;
  const timing=rr.find(x=>x.type==='manifest')?.server?.verifierTiming;if(timing?.configuredCacheMs!==entry.config.cacheMs||timing?.snapshotFreshnessLimitMs!==entry.config.cacheMs||timing?.tokenMs!==entry.config.tokenMs)return {valid:false,reason:'verifier timing mismatch'};
  if(s.length!==expected||new Set(s.map(x=>x.sequence)).size!==expected)return {valid:false,reason:'schedule mismatch'};
  const responded=s.filter(x=>x.responseReceived);if(responded.some(x=>!x.trace?.issue?.correlationId||x.trace.issue.correlationId!==x.trace.correlationId||x.trace.verify&&x.trace.verify.correlationId!==x.trace.correlationId))return {valid:false,reason:'missing or inconsistent correlation trace'};
  if(responded.some(x=>x.trace.verify && (x.trace.issue.tokenIssuedAtMs===null || x.trace.issue.issuanceAnchorAtMs===undefined || x.trace.issue.tokenIssuedAtMs<x.trace.issue.issuanceAnchorAtMs)))return {valid:false,reason:'successful issuance lacks signed-token timestamp'};
  if(responded.some(x=>!x.trace.verify&&x.decision!=='ALLOW'&&x.trace.issue.tokenIssuedAtMs!==null))return {valid:false,reason:'failed issuance must not claim emitted token'};
  const res=rr.filter(x=>x.type==='resource');if(res.some((x,i)=>i&&x.generator.at-res[i-1].generator.at>60000))return {valid:false,reason:'clock/resource interruption >60s'};
  return {valid:true,samples:s.length,responses:responded.length,missingTraceSamples:s.filter(x=>x.decision!=='DROPPED'&&!x.trace).length};
 }
 if(entry.group==='revocation'){
  const ref=rr.find(x=>x.type==='revocation'),fault=rr.find(x=>x.type==='fault-evidence');if(!ref||!fault||(entry.config.dropEvents&&fault.droppedLogs<1)||!rr.some(x=>x.type==='precondition'&&x.bothAllowed))return {valid:false,reason:'reference or dropped-event proof missing'};
  for(const c of ['old-token','refresh']){const s=rr.filter(x=>x.type==='sample'&&x.cohort===c&&x.startedAt>=ref.referenceAt);if(s.length<1||s.at(-1).decisionAt<ref.referenceAt+entry.config.observeMs-1000)return {valid:false,reason:'incomplete observation cohort'};}
  return {valid:true,samples:rr.filter(x=>x.type==='sample').length};
 }
 const result=rr.find(x=>x.type==='key-result');return {valid:!!result&&result.preAccepted&&result.newAccepted&&result.remainingMs>0&&result.conditionsMatch,reason:result?'conditions and controls checked':'missing key result'};
 }catch(e){return {valid:false,reason:e.message};}}
async function unit(id,group,config,smoke=false,retryBudget=2){
 for(const old of m.attempts.filter(x=>x.id===id&&x.state==='VALID')){const v=JSON.stringify(old.config)===JSON.stringify(config)?await validate(old):{valid:false,reason:'configuration changed'};if(v.valid){console.log('SKIP',id);return;}old.state='INVALID';old.validation=v;}
 const previous=m.attempts.filter(x=>x.id===id);const a={id,group,config,smoke,attempt:previous.length+1,retryOf:previous.at(-1)?.path??null,path:'raw/'+id+'-attempt'+(previous.length+1),state:'RUNNING',startedAt:new Date().toISOString(),sourceHashes};m.attempts.push(a);await mkdir(resolve(out,a.path));await save();
 const configPath=resolve(out,a.path,'input-config.json');await writeFile(configPath,JSON.stringify(config,null,2));
 const args=group==='http'?['tooling/emukey/research/http-load.mjs',configPath]:[resolve(repo,'tooling/emukey/research/e01-revocation.mjs'),resolve(out,a.path),JSON.stringify(config)];
 const file=await open(resolve(out,a.path,'process.log'),'wx');let writes=Promise.resolve();
 const code=await new Promise(ok=>{const p=spawn(process.execPath,args,{cwd:group==='http'?repo:resolve(repo,'EmuKey/backend'),windowsHide:true,env:{...process.env,RESEARCH_LOAD_OUTPUT:resolve(out,a.path)},stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>{writes=writes.then(()=>file.write(b));});p.stderr.on('data',b=>{writes=writes.then(()=>file.write(b));});p.on('error',()=>ok(-1));p.on('close',ok);});await writes;await file.close();
 a.exitCode=code;a.validation=await validate(a);a.state=code===0&&a.validation.valid?'VALID':'INVALID';a.finishedAt=new Date().toISOString();
 const startupLog=await readFile(resolve(out,a.path,'process.log'),'utf8');
 if(a.state!=='VALID'&&startupLog.includes('Error: HTTP_429')){a.validation.reason='Login HTTP_429 before measurement; cooldown 65 seconds, no authorization-policy change';a.cooldownMs=65000;}
 await writeFile(resolve(out,a.path,'run-manifest.json'),JSON.stringify(a,null,2));await save();console.log(id,a.state);
 if(a.cooldownMs)await new Promise(r=>setTimeout(r,a.cooldownMs));
 if(a.state!=='VALID'&&retryBudget>0)return unit(id,group,config,smoke,retryBudget-1);
 if(a.state!=='VALID')throw new Error('SMOKE_BLOCKED:'+id);
}
try{
 const base={licenses:10,rate:25,durationMs:20000,warmupMs:2000,cacheMs:1000,tokenMs:800,concurrency:64,timeoutMs:10000,repetitions:1,seed:4101,distribution:'hot80',purpose:'formal'};
 for(const cacheMs of [1000,2000,5000])await unit('smoke-http-'+cacheMs,'http',{...base,cacheMs,tokenMs:2000,strategies:['HYBRID'],rate:5,durationMs:2000,warmupMs:100,purpose:'smoke'},true);
 for(const dropEvents of [false,true])await unit('smoke-revocation-'+dropEvents,'revocation',{cacheMs:1000,tokenMs:800,pollMs:10000,observeMs:13000,offsetMs:500,seed:4101,dropEvents},true);
 for(let i=0;i<5;i++){
  const seed=4101+i,configs=[];
  for(const rate of [25,50,100])for(const tokenMs of [800,1000,2000]){
   configs.push({...base,rate,tokenMs,cacheMs:5000,seed,strategies:['DIRECT_ONCHAIN']});
   for(const cacheMs of [1000,2000,5000])configs.push({...base,rate,tokenMs,cacheMs,seed,strategies:['HYBRID']});
  }
  const n=(i*7)%configs.length,order=[...configs.slice(n),...configs.slice(0,n)];
  for(const c of order)await unit(`http-${c.strategies[0]}-${c.cacheMs}-${c.tokenMs}-${c.rate}-${seed}`,'http',c);
 }
 for(let i=0;i<5;i++){
  const seed=4101+i,offsetMs=500+i*1800+((Math.imul(seed,1664525)+1013904223)>>>0)%700;
  const configs=[];for(const cacheMs of [1000,2000,5000])for(const tokenMs of [800,1000,2000])for(const dropEvents of [false,true])configs.push({cacheMs,tokenMs,dropEvents,pollMs:10000,observeMs:13000,offsetMs,seed});
  const n=(i*5)%configs.length;for(const c of [...configs.slice(n),...configs.slice(0,n)])await unit(`revocation-${c.cacheMs}-${c.tokenMs}-${c.dropEvents}-${seed}`,'revocation',c);
 }
 m.status='MEASUREMENTS_FINISHED';await save();
}catch(e){m.status='BLOCKED';m.error=e.message;await save();process.exitCode=1;}finally{await import('node:fs/promises').then(f=>f.unlink(lock));}
