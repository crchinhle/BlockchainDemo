import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {db,redis,initialize,json} from '../../../EmuKey/backend/dist/modules/research/infrastructure.js';
import {ChainV2} from '../../../EmuKey/backend/dist/modules/research/protocol-v2.js';
import {runExperimentV2} from '../../../EmuKey/backend/dist/modules/research/runner-v2.js';
import {defaults} from '../../../EmuKey/backend/dist/modules/research/domain.js';
await initialize();
try{
 const offline=process.argv.includes('--central-offline');
 if(offline)process.env.RESEARCH_RPC_URL='http://127.0.0.1:1';
 const chain=new ChainV2();if(!offline)await chain.init();
 for(const strategy of offline?['CENTRALIZED']:['CENTRALIZED','DIRECT_ONCHAIN','HYBRID']){
  const id=randomUUID(),config={...defaults,strategy,observeMs:2000,cacheTtlMs:1000,tokenTtlMs:800,freshnessMs:1000};
  await db.query("INSERT INTO research.runs(id,owner,name,config,state) VALUES($1,'researcher','V2 runner acceptance',$2,'QUEUED')",[id,json(config)]);
  await runExperimentV2(id,chain);
  const run=(await db.query('SELECT state,error,manifest FROM research.runs WHERE id=$1',[id])).rows[0];
  assert.equal(run.state,'COMPLETED',run.error);
  const samples=(await db.query('SELECT data FROM research.samples WHERE run_id=$1',[id])).rows.map(r=>r.data);
  assert(samples.some(s=>s.decision==='ALLOW'));
  assert(samples.some(s=>s.decision==='DENY'));
  if(strategy==='CENTRALIZED'){assert(samples.every(s=>s.rpcCalls===0));assert.equal((await db.query('SELECT count(*) FROM research.v2_commands WHERE run_id=$1',[id])).rows[0].count,'0');}
  console.log('PASS',strategy,id,samples.length,'samples',samples.filter(s=>s.decision==='ERROR').length,'errors');
 }
}finally{await db.end();redis.disconnect();}
