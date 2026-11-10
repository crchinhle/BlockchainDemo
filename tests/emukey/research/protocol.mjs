import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../EmuKey/backend/package.json',import.meta.url));
const {privateKeyToAccount,generatePrivateKey}=await import(pathToFileURL(require.resolve('viem/accounts')).href);
const {uuidToBytes16,planCommitment,activationCommitment}=await import('../../../EmuKey/backend/dist/platform/crypto/license-crypto.js');
const {db,redis,initialize,ResearchChain,json,digest}=await import('../../../EmuKey/backend/dist/modules/research/infrastructure.js');
const {ResearchVerificationStrategy}=await import('../../../EmuKey/backend/dist/modules/research/verification.js');
const {defaults}=await import('../../../EmuKey/backend/dist/modules/research/domain.js');
await initialize();const chain=new ResearchChain();await chain.init();
try{
 const run=randomUUID(),rep=randomUUID(),license=randomUUID(),product=randomUUID(),plan=randomUUID();
 await db.query("INSERT INTO research.runs(id,owner,name,config,state,manifest) VALUES($1,'protocol-test','TEST FIXTURE', $2,'TEST_FIXTURE',$3)",[run,json(defaults),json({testFixture:true,nonResearch:true})]);
 await db.query("INSERT INTO research.repetitions(id,run_id,ordinal,state) VALUES($1,$2,1,'TEST_FIXTURE')",[rep,run]);
 const args=[chain.signer,uuidToBytes16(product),uuidToBytes16(plan),1n,planCommitment({durationMonths:1,entitlements:{test:true},maxActiveDevices:1,planId:plan,planVersion:1,productId:product,providerChainAddress:chain.signer}),activationCommitment(`0x${randomBytes(32).toString('hex')}`),1n,1n,BigInt(Math.floor(Date.now()/1000)+600)];
 await chain.command(run,rep,license,'issueLicense',args);
 await assert.rejects(chain.command(run,rep,license,'issueLicense',args),/COMMAND_ALREADY_EXISTS/);
 await assert.rejects(chain.command(run,rep,license,'issueLicense',[...args.slice(0,-1),args.at(-1)+1n]),/PAYLOAD_CONFLICT/);
 await db.query('INSERT INTO research.licenses(id,run_id,product_id,expires_at,max_devices,status) VALUES($1,$2,$3,$4,1,1)',[license,run,product,Date.now()+600000]);
 const verifier=new ResearchVerificationStrategy(chain,defaults,run,rep);const account=privateKeyToAccount(generatePrivateKey());const device=randomUUID();
 const activation=await verifier.challenge(license,device,'activate'),sig=await account.signMessage({message:activation.message});
 await verifier.activate(license,device,account.address,activation.nonce,sig);await assert.rejects(verifier.activate(license,device,account.address,activation.nonce,sig),/REPLAY/);
 const repeated=await verifier.challenge(license,device,'activate');await verifier.activate(license,device,account.address,repeated.nonce,await account.signMessage({message:repeated.message}));
 assert.equal(Number((await db.query('SELECT count(*) FROM research.devices WHERE license_id=$1',[license])).rows[0].count),1);
 const another=randomUUID(),other=await verifier.challenge(license,another,'activate');await assert.rejects(verifier.activate(license,another,account.address,other.nonce,await account.signMessage({message:other.message})),/DEVICE_LIMIT/);
 const issue=await verifier.challenge(license,device,'issue');const token=await verifier.issue(license,device,issue.nonce,await account.signMessage({message:issue.message}));
 const valid=await verifier.challenge(license,device,'verify');assert.equal((await verifier.verify(license,device,token.token,valid.nonce,await account.signMessage({message:valid.message}))).source,'old-signed-snapshot + postgres-device');
 await db.query('UPDATE research.devices SET generation=2 WHERE license_id=$1',[license]);
 const generation=await verifier.challenge(license,device,'verify');await assert.rejects(verifier.verify(license,device,token.token,generation.nonce,await account.signMessage({message:generation.message})),/TOKEN_BINDING/);
 const race=new ResearchVerificationStrategy(chain,{...defaults,fault:'cache-race',faultDurationMs:300},run,rep);
 await redis.del(race.key(license));const refill=race.snapshot(license);await new Promise(r=>setTimeout(r,80));await race.invalidate(license,{...await chain.snapshot(license),status:3});await assert.rejects(refill,/CACHE_EPOCH_CHANGED/);assert.equal(await redis.exists(race.key(license)),0);
 assert.equal((await chain.snapshot(license)).status,1,'Other experiment revocations must not revoke sentinel');
 // Test access control via intentionally minted local test sessions, never printed or exported.
 for(const [role,owner,status] of [['viewer','researcher',403],['researcher','different-user',404]]){
  const sid=randomBytes(24).toString('hex');await redis.set('research:session:'+digest(sid),json({username:owner,role}),'EX',30);
  const response=await fetch('http://127.0.0.1:3100/api/research/runs/'+run,{headers:{Cookie:'research_session='+sid}});assert.equal(response.status,status);await redis.del('research:session:'+digest(sid));
 }
 console.log('Protocol integration PASS: real issuance, payload idempotency, device cap, replay, generation binding, late-cache epoch fencing, unaffected sentinel, 403/ownership.');
}finally{await db.end();redis.disconnect();}
