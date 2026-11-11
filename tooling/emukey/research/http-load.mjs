import {readFile,mkdir,open,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import os from 'node:os';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../../EmuKey/backend/package.json',import.meta.url));
const {privateKeyToAccount,generatePrivateKey}=await import(pathToFileURL(require.resolve('viem/accounts')).href);
const defaults={strategies:['CENTRALIZED','CENTRALIZED_CACHE','DIRECT_ONCHAIN','HYBRID'],licenses:3,rate:5,durationMs:2000,warmupMs:0,cacheMs:1000,tokenMs:800,concurrency:16,timeoutMs:10000,repetitions:1,seed:1001,distribution:'uniform',revokeAtMs:null,purpose:'smoke'};
const input=process.argv[2]?JSON.parse(await readFile(resolve(process.argv[2]),'utf8')):{};
for(const k of Object.keys(input))if(!(k in defaults))throw new Error('UNKNOWN_CONFIG:'+k);
const config={...defaults,...input};
for(const [key,min,max] of [['licenses',1,100000],['rate',1,400],['durationMs',1000,1800000],['warmupMs',0,300000],['cacheMs',100,120000],['tokenMs',100,120000],['concurrency',1,512],['timeoutMs',100,120000],['repetitions',1,10],['seed',1,2147483647]])if(!Number.isInteger(config[key])||config[key]<min||config[key]>max)throw new Error('INVALID_CONFIG:'+key);
if(!['uniform','hot80'].includes(config.distribution)||!['smoke','pilot','formal'].includes(config.purpose)||!Array.isArray(config.strategies)||!config.strategies.length||config.strategies.some(s=>!defaults.strategies.includes(s)))throw new Error('INVALID_MODE');
if(config.revokeAtMs!==null&&(!Number.isInteger(config.revokeAtMs)||config.revokeAtMs<0||config.revokeAtMs>=config.durationMs))throw new Error('INVALID_REVOKE_TIME');
const output=resolve(root,'EmuKey/backend/.research-local/evidence/http-load-'+Date.now()+'-'+randomUUID());await mkdir(output,{recursive:true});
await writeFile(resolve(output,'config.json'),JSON.stringify(config,null,2),{flag:'wx'});
const credentials=JSON.parse(await readFile(resolve(root,'EmuKey/backend/.research-local/login.json'),'utf8'));
const base='http://127.0.0.1:3100/api/research';let cookie='';
async function api(path,body,timeout=config.timeoutMs){const r=await fetch(base+path,{headers:{'Content-Type':'application/json',Cookie:cookie},signal:AbortSignal.timeout(timeout),...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});if(!r.ok)throw new Error('HTTP_'+r.status);if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r.json();}
try{await api('/login',credentials);}catch(e){await writeFile(resolve(output,'startup-failure.json'),JSON.stringify({state:'FAILED',phase:'login',reason:e.name,at:Date.now()}),{flag:'wx'});throw e;}
function random(seed){let n=seed>>>0;return()=>{n=(Math.imul(1664525,n)+1013904223)>>>0;return n/4294967296;};}
const order=[],rng=random(config.seed);
for(let repetition=0;repetition<config.repetitions;repetition++){const strategies=[...config.strategies];for(let i=strategies.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[strategies[i],strategies[j]]=[strategies[j],strategies[i]];}for(const strategy of strategies)order.push({repetition,strategy,seed:config.seed+repetition});}
await writeFile(resolve(output,'schedule.json'),JSON.stringify({order,generatorCodeHash:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),host:{platform:os.platform(),release:os.release(),cpus:os.cpus().length,cpu:os.cpus()[0]?.model,totalMemory:os.totalmem()},node:process.version,boundary:'client monotonic start before challenge HTTP; ends after full protected response; includes signing and token issue each request',generatorPid:process.pid},null,2),{flag:'wx'});
let interrupted=false;process.on('SIGINT',()=>{interrupted=true;});process.on('SIGTERM',()=>{interrupted=true;});
for(const plan of order){
 if(interrupted)break;
 const file=await open(resolve(output,`${plan.repetition}-${plan.strategy}.ndjson`),'wx');let writes=Promise.resolve();
 const record=value=>{writes=writes.then(()=>file.write(JSON.stringify(value)+'\n'));return writes;};
 let session,metricsTimer,metricTask=Promise.resolve(),revocation;const startedAt=Date.now();
 try{
  session=await api('/benchmarks',{strategy:plan.strategy,licenses:config.licenses,cacheMs:config.cacheMs,tokenMs:config.tokenMs});await record({type:'manifest',...plan,session:session.id,server:session.manifest,startedAt});
  const keys=[];for(let i=0;i<config.licenses&&!interrupted;i++){const account=privateKeyToAccount(generatePrivateKey());await api(`/benchmarks/${session.id}/fixtures`,{key:account.address},120000);keys.push(account);await record({type:'fixture',index:i});}
  if(interrupted)throw new Error('INTERRUPTED');
  const request=async(index)=>{
   const metrics={rpcCalls:0,cacheHits:0};
   const proof=async()=>{const c=await api(`/benchmarks/${session.id}/request`,{index,operation:'challenge'});return {nonce:c.nonce,signature:await keys[index].signMessage({message:c.message})};};
   const issued=await api(`/benchmarks/${session.id}/request`,{index,operation:'issue',...await proof()});
   metrics.rpcCalls+=issued.metrics?.rpcCalls??0;metrics.cacheHits+=issued.metrics?.cacheHits??0;
   if(issued.decision!=='ALLOW')return {...issued,metrics};
   const decision=await api(`/benchmarks/${session.id}/request`,{index,operation:'verify',token:issued.token,...await proof()});
   metrics.rpcCalls+=decision.metrics?.rpcCalls??0;metrics.cacheHits+=decision.metrics?.cacheHits??0;
   return {...decision,metrics};
  };
  const warmStart=performance.now();let warmIndex=0;while(performance.now()-warmStart<config.warmupMs&&!interrupted){const r=await request(warmIndex++%keys.length);await record({type:'warmup',decision:r.decision,reason:r.reason,metrics:r.metrics});}
  async function metric(){try{await record({type:'resource',server:await api('/benchmark-metrics'),generator:{pid:process.pid,at:Date.now(),cpu:process.cpuUsage(),memory:process.memoryUsage()}});}catch(e){await record({type:'resource-error',reason:e.message});}}
  await metric();metricsTimer=setInterval(()=>{metricTask=metricTask.then(metric);},1000);
  const start=performance.now(),startUtc=Date.now(),tasks=new Set(),workload=random(plan.seed);let seq=0;
  const count=Math.ceil(config.rate*config.durationMs/1000);
  for(;seq<count&&!interrupted;seq++){
   const due=seq*1000/config.rate;await new Promise(r=>setTimeout(r,Math.max(0,due-(performance.now()-start))));
   let index;const hot=Math.max(1,Math.ceil(config.licenses*.2));if(config.distribution==='hot80'&&hot<config.licenses){index=workload()<0.8?Math.floor(workload()*hot):hot+Math.floor(workload()*(config.licenses-hot));}else index=Math.floor(workload()*config.licenses);
   if(config.revokeAtMs!==null&&!revocation&&performance.now()-start>=config.revokeAtMs){revocation=api(`/benchmarks/${session.id}/revoke`,{index:0},120000).then(result=>record({type:'revocation',result}),e=>record({type:'revocation-error',reason:e.message}));}
   const scheduledAt=startUtc+due,lagMs=Math.max(0,performance.now()-start-due),sequence=seq;
   if(tasks.size>=config.concurrency){await record({type:'sample',sequence,index,scheduledAt,lagMs,decision:'DROPPED',reason:'GENERATOR_CONCURRENCY'});continue;}
   const task=(async()=>{const began=performance.now(),at=Date.now();try{const r=await request(index);await record({type:'sample',sequence,index,scheduledAt,lagMs,startedAt:at,endedAt:Date.now(),latencyMs:performance.now()-began,decision:r.decision,reason:r.reason,metrics:r.metrics,responseReceived:true});}catch(e){await record({type:'sample',sequence,index,scheduledAt,lagMs,startedAt:at,endedAt:Date.now(),latencyMs:performance.now()-began,decision:/Timeout|Abort/.test(e.name)?'TIMEOUT':'ERROR',reason:e.name, responseReceived:false,outcome:'unknown-if-server-completed'});}})();tasks.add(task);void task.then(()=>tasks.delete(task),()=>tasks.delete(task));
  }
  await Promise.allSettled(tasks);if(revocation)await revocation;await record({type:'end',state:interrupted?'INTERRUPTED':'COMPLETED',scheduled:count,attempted:seq,elapsedMs:performance.now()-start});
 }catch(e){await record({type:'end',state:interrupted?'INTERRUPTED':'FAILED',reason:e.message});process.exitCode=1;}
 finally{clearInterval(metricsTimer);await metricTask;if(session)await api(`/benchmarks/${session.id}/finish`,{}).catch(e=>record({type:'finish-error',reason:e.message}));await writes;await file.close();}
 console.log(plan.strategy,'repetition',plan.repetition,'recorded');
}
const {readdir}=await import('node:fs/promises');const checksums={};for(const file of await readdir(output))checksums[file]=createHash('sha256').update(await readFile(resolve(output,file))).digest('hex');await writeFile(resolve(output,'checksums.json'),JSON.stringify(checksums,null,2),{flag:'wx'});
console.log('Evidence:',output);
