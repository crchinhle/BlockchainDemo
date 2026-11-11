import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(resolve(tmpdir(),'emukey-load-')),config=resolve(dir,'config.json');
await writeFile(config,JSON.stringify({licenses:1,durationMs:3000,rate:5,cacheMs:5000,tokenMs:3000,revokeAtMs:1000}));
const {stdout}=await promisify(execFile)(process.execPath,['tooling/emukey/research/http-load.mjs',config],{windowsHide:true,timeout:180000});
const path=stdout.match(/Evidence: (.+)/)?.[1]?.trim();assert(path,'Evidence directory returned');
for(const name of (await readdir(path)).filter(n=>n.endsWith('.ndjson'))){
 const rows=(await readFile(resolve(path,name),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.find(r=>r.type==='end').state,'COMPLETED');
 const samples=rows.filter(r=>r.type==='sample'),revoked=rows.find(r=>r.type==='revocation');assert(revoked);
 assert(samples.some(s=>s.decision==='ALLOW'));assert(samples.some(s=>s.decision==='DENY'));
 assert(samples.filter(s=>s.startedAt>revoked.result.referenceAt+200).every(s=>s.decision==='DENY'));
 assert(rows.some(r=>r.type==='resource'&&r.server.pid!==r.generator?.pid));
 assert(!JSON.stringify(rows).includes('"token":'));
 if(name.includes('CENTRALIZED'))assert(samples.every(s=>(s.metrics?.rpcCalls??0)===0));
 console.log('PASS HTTP full decision and revocation',name,samples.length,'samples');
}
console.log('Retained evidence',path);
