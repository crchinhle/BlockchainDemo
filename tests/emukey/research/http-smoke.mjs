import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const root=new URL('../../../',import.meta.url);
const creds=JSON.parse(await readFile(new URL('EmuKey/backend/.research-local/login.json',root),'utf8'));
const base='http://127.0.0.1:3100/api/research';let cookie='';
async function call(path,body,status=200){const r=await fetch(base+path,{headers:{'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});assert.ok(r.status===status||status===200&&r.status===201,`${path} ${r.status} ${await r.clone().text()}`);if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r;}
assert.equal((await fetch(base+'/runs')).status,401);
await call('/login',creds);
assert.equal((await (await call('/preflight')).json()).ok,true);
await call('/runs',{cacheTtlMs:0},400);
const results=[];
for(const config of [
 {name:'Smoke final HYBRID',strategy:'HYBRID'},
 {name:'Smoke direct',strategy:'DIRECT_ONCHAIN'},
 {name:'Smoke centralized',strategy:'CENTRALIZED'},
 {name:'Event dropped + long polling',strategy:'HYBRID',eventMode:'dropped',pollMs:10000},
 {name:'RPC outage',strategy:'DIRECT_ONCHAIN',fault:'rpc-outage',faultDurationMs:1000},
]){
 const run=await (await call('/runs',config)).json();await call(`/runs/${run.id}/start`,{});await call(`/runs/${run.id}/start`,{},409);
 let data;for(let i=0;i<90;i++){data=await (await call(`/runs/${run.id}`)).json();if(['COMPLETED','FAILED','CANCELLED','INTERRUPTED'].includes(data.run.state))break;await new Promise(r=>setTimeout(r,500));}
 assert.equal(data.run.state,'COMPLETED',JSON.stringify(data.run));if(config.strategy!=='CENTRALIZED')assert.ok(data.events.some(e=>e.kind==='issue_included'));assert.ok(data.events.some(e=>e.kind==='activated'));assert.ok(data.events.some(e=>e.kind==='warmed'));if(config.strategy==='CENTRALIZED'){assert.ok(data.events.some(e=>e.kind==='central_committed'));assert.ok(!data.events.some(e=>e.kind==='revoke_broadcast'));}else{assert.ok(data.events.some(e=>e.kind==='revoke_included'));assert.ok(data.events.some(e=>e.kind==='confirmed'));}
 const tc=Number(data.repetitions[0].tc);assert.ok(data.samples.some(s=>s.decisionStartedAt>tc));assert.ok(data.samples.some(s=>s.decision==='ALLOW'));assert.ok(data.samples.some(s=>s.decision==='DENY'));
 if(config.eventMode==='dropped')assert.ok(data.summary.staleAccepts>0,'Fault experiment must expose stale token acceptance');
 if(config.fault==='rpc-outage')assert.ok(data.samples.some(s=>s.reason==='RPC_OUTAGE_INJECTED'));
 if(config.name==='Smoke final HYBRID')assert.ok(data.samples.filter(s=>s.decision==='ERROR').every(s=>s.reason==='CACHE_EPOCH_CHANGED'),'Only the explicit invalidation race may degrade availability; keep it in samples');
 const exported=await (await call(`/runs/${run.id}/export?format=json`)).json();const {dataHash,createdAt,...dataset}=exported;assert.equal(createHash('sha256').update(canonical(dataset)).digest('hex'),dataHash);assert.equal(exported.samples.length,data.samples.length);assert.equal(JSON.stringify(exported).includes(creds.password),false);assert.equal(JSON.stringify(exported).includes('"token":'),false);
 const out=new URL('EmuKey/backend/.research-local/evidence/',root);await mkdir(out,{recursive:true});await writeFile(new URL(run.id+'.json',out),JSON.stringify(exported,null,2));
 const csv=await (await call(`/runs/${run.id}/export?format=samples.csv`)).text();assert.equal(csv.trim().split('\n').length,data.samples.length+1);
 results.push({id:run.id,name:config.name,samples:data.samples.length,summary:data.repetitions[0].summary});console.log(JSON.stringify(results.at(-1)));
}
console.log('HTTP integration: PASS',results.length,'v2 integration runs');
