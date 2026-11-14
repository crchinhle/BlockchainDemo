// E01: real authorities, isolated probe load; secrets stay in memory.
import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const require=createRequire(new URL('../../../EmuKey/backend/package.json',import.meta.url));
const {privateKeyToAccount,generatePrivateKey}=await import(pathToFileURL(require.resolve('viem/accounts')).href);
const {keccak256,toHex}=await import(pathToFileURL(require.resolve('viem')).href);
const {db,redis,initialize,json}=await import('../../../EmuKey/backend/dist/modules/research/infrastructure.js');
const {ChainV2,VerifierV2,deviceIdentity,decisionMetrics}=await import('../../../EmuKey/backend/dist/modules/research/protocol-v2.js');
const {uuidToBytes16}=await import('../../../EmuKey/backend/dist/platform/crypto/license-crypto.js');
const [out,encoded]=process.argv.slice(2),c=JSON.parse(encoded);
const file=await open(resolve(out,'samples.ndjson'),'wx');
let writes=Promise.resolve();const record=x=>writes=writes.then(()=>file.write(json(x)+'\n'));
const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
let stop=false,monitor;
try {
 await initialize();const chain=new ChainV2();await chain.init();
 const license=randomUUID(),product=randomUUID(),keys=Object.fromEntries(['old-token','refresh'].map(k=>[k,privateKeyToAccount(generatePrivateKey())]));
 await record({type:'manifest',config:c,chain:await chain.fingerprint(),boundary:'isolated direct verifier probes, no concurrent HTTP load',configuredCacheMs:c.cacheMs,snapshotFreshnessLimitMs:c.cacheMs,effectiveCacheMs:c.cacheMs});
 await chain.send(chain.signer,'registerProduct',[uuidToBytes16(product),chain.signer]);
 await chain.send(chain.signer,'issue',[uuidToBytes16(license),uuidToBytes16(product),chain.owner,BigInt(Math.floor(Date.now()/1000)+86400),2,true]);
 for(const k of Object.values(keys))await chain.send(chain.owner,'activate',[uuidToBytes16(license),deviceIdentity(license,k.address),1n,keccak256(toHex(randomUUID()))]);
 const v=new VerifierV2(chain,'HYBRID',randomUUID(),c.cacheMs,c.tokenMs),cursor=randomUUID();
 const proof=async cohort=>{const k=keys[cohort],p=await v.challenge(license,product,k.address);return [p.nonce,await k.signMessage({message:p.message})];};
 const issue=async cohort=>v.issue(license,product,keys[cohort].address,...await proof(cohort));
 const verify=async(cohort,t)=>v.verify(license,product,keys[cohort].address,t,...await proof(cohort));
 await v.synchronize([license],cursor,false);
 let phase='probe',droppedLogs=0,referenceAt=null;
 const invalidate=v.invalidate.bind(v);v.invalidate=async(...args)=>{const detectedAt=Date.now();await invalidate(...args);await record({type:'version-applied',path:phase,detectedAt,appliedAt:Date.now(),version:args[1]?.version,revoked:args[1]?.revoked});};
 const logs=chain.rpc.getLogs.bind(chain.rpc);chain.rpc.getLogs=async args=>{const r=await logs(args),matches=r.filter(x=>x.args?.licenseId===uuidToBytes16(license));if(matches.length){if(c.dropEvents)droppedLogs+=matches.length;await record({type:'event-observed',at:Date.now(),dropped:c.dropEvents,logs:matches});}return r;};
 const origin=Date.now();let nextPoll=origin+c.pollMs;
 await record({type:'schedule',originAt:origin,scheduledAt:origin+c.offsetMs,offsetMs:c.offsetMs,seed:c.seed});
 monitor=(async()=>{while(!stop){phase='event';await v.synchronize([license],cursor,c.dropEvents);if(Date.now()>=nextPoll){phase='poll';const readStartedAt=Date.now(),s=await chain.read(license,deviceIdentity(license,keys['old-token'].address));await record({type:'detection',path:'poll',readStartedAt,detectedAt:Date.now(),state:s});await v.invalidate(license,s);nextPoll+=c.pollMs;}await sleep(100);}})();
 // Obtain both credentials immediately before the seeded revocation time. Otherwise
 // sub-second old credentials would expire while waiting for the offset.
 await sleep(origin+c.offsetMs-150-Date.now());
 const old=await issue('old-token'),fresh=await issue('refresh');
 await verify('old-token',old.token);await verify('refresh',fresh.token);
 await record({type:'precondition',at:Date.now(),bothAllowed:true,oldDeadline:old.deadline,refreshDeadline:fresh.deadline});
 await sleep(origin+c.offsetMs-Date.now());const submittedAt=Date.now();
 const receipt=await chain.send(chain.signer,'revoke',[uuidToBytes16(license)]);
 if((await chain.rpc.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new Error('NONCANONICAL_RECEIPT');
 referenceAt=Date.now();await record({type:'revocation',scheduledAt:origin+c.offsetMs,submittedAt,referenceAt,receipt});
 const begin=performance.now();let previous=Date.now();
 while(performance.now()-begin<c.observeMs){const tick=Date.now();await record({type:'cadence',at:tick,intervalMs:tick-previous});previous=tick;
  for(const cohort of ['old-token','refresh']){const startedAt=Date.now(),metrics={rpcCalls:0,cacheHits:0,trace:{}},issuance={attempted:cohort==='refresh'};let stage='issue';
   await decisionMetrics.run(metrics,async()=>{try{let t=old.token;if(cohort==='refresh'){const r=await issue(cohort);t=r.token;Object.assign(issuance,{decision:'ALLOW',issuedAt:Date.now(),deadline:r.deadline,trace:{...metrics.trace}});}stage='verify';await verify(cohort,t);await record({type:'sample',cohort,startedAt,decisionAt:Date.now(),decision:'ALLOW',issuance,accessAttempted:true,metrics});}catch(e){const decision=/TOKEN_|LICENSE_|PRODUCT_|PROOF_|REPLAY|JWT|signature|exp.*claim/i.test(e.message)?'DENY':'ERROR';if(stage==='issue')Object.assign(issuance,{decision,reason:e.message});await record({type:'sample',cohort,startedAt,decisionAt:Date.now(),decision,reason:e.message,issuance,accessAttempted:stage==='verify',metrics});}});
  }await sleep(100-(Date.now()-tick));
 }
 stop=true;await monitor;
 await record({type:'fault-evidence',dropEvents:c.dropEvents,droppedLogs,observationEndAt:Date.now()});
 if(c.dropEvents&&!droppedLogs)throw new Error('EVENT_DROP_NOT_OBSERVED');
 await record({type:'end',state:'COMPLETED'});
}catch(e){await record({type:'end',state:'FAILED',reason:e.shortMessage??e.message});process.exitCode=1;}
finally{stop=true;if(monitor)await monitor.catch(()=>{});await writes;await file.close();await db.end();redis.disconnect();}
