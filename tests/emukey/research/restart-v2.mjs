// Pass only the PID of this workspace's idle research worker, verified by the operator.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {db,redis,initialize} from '../../../EmuKey/backend/dist/modules/research/infrastructure.js';
const pid=Number(process.argv[2]);assert(Number.isInteger(pid)&&pid>0,'Verified worker PID required');
await initialize();
try{
 assert.equal(Number((await db.query("SELECT count(*) FROM research.runs WHERE state IN ('QUEUED','PREPARING','WARMING','RUNNING','REVOKING','OBSERVING')")).rows[0].count),0,'Do not interrupt another experiment');
 const credentials=JSON.parse(await readFile('.research-local/login.json','utf8'));
 const base='http://127.0.0.1:3100/api/research';let cookie='';
 for(let i=0;i<100;i++){try{await fetch(base+'/runs');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 async function api(path,body){const r=await fetch(base+path,{headers:{'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});assert(r.ok);if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r.json();}
 await api('/login',credentials);const run=await api('/runs',{name:'V2 worker restart acceptance',observeMs:15000});await api('/runs/'+run.id+'/start',{});
 let state;for(let i=0;i<100;i++){state=await api('/runs/'+run.id);if(state.run.state==='OBSERVING')break;await new Promise(r=>setTimeout(r,200));}assert.equal(state.run.state,'OBSERVING');
 const before=(await db.query('SELECT hash FROM research.v2_commands WHERE run_id=$1 ORDER BY id',[run.id])).rows;
 process.kill(pid);
 const worker=spawn(process.execPath,['dist/entrypoints/research/main.js','--worker'],{cwd:process.cwd(),windowsHide:true,detached:true,stdio:'ignore'});worker.unref();
 for(let i=0;i<100;i++){state=await api('/runs/'+run.id);if(state.run.state==='INTERRUPTED')break;await new Promise(r=>setTimeout(r,200));}assert.equal(state.run.state,'INTERRUPTED');
 assert.deepEqual((await db.query('SELECT hash FROM research.v2_commands WHERE run_id=$1 ORDER BY id',[run.id])).rows,before);
 assert(state.samples.length>0);assert.equal((await db.query('SELECT count(*) FROM research.artifacts WHERE run_id=$1',[run.id])).rows[0].count,'1');
 console.log('PASS interrupted run',run.id,'partial samples',state.samples.length,'unchanged broadcasts; replacement worker PID',worker.pid);
}finally{await db.end();redis.disconnect();}
