import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(new URL('../../../EmuKey/backend/package.json',import.meta.url));
const {privateKeyToAccount,generatePrivateKey}=await import(pathToFileURL(require.resolve('viem/accounts')).href);
const {keccak256,toHex}=await import(pathToFileURL(require.resolve('viem')).href);
const {db,redis,initialize,json}=await import('../../../EmuKey/backend/dist/modules/research/infrastructure.js');
const {ChainV2,VerifierV2,deviceIdentity,centralIssue,centralMutate,centralSnapshot}=await import('../../../EmuKey/backend/dist/modules/research/protocol-v2.js');
const {uuidToBytes16}=await import('../../../EmuKey/backend/dist/platform/crypto/license-crypto.js');
await initialize();
const chain=new ChainV2(),evidence={kind:'acceptance-smoke-v2',started:new Date().toISOString(),checks:[],transactions:[]};
const req=()=>keccak256(toHex(randomUUID()));
async function check(name,fn){await fn();evidence.checks.push(name);console.log('PASS',name);}
try{
 await chain.init(true);
 const accounts=await chain.wallet.getAddresses(),issuer=accounts[0],owner=accounts[1],next=accounts[2],wrong=accounts[3];
 const product=randomUUID(),license=randomUUID(),id=uuidToBytes16(license),p=uuidToBytes16(product);
 const deviceKey=privateKeyToAccount(generatePrivateKey()),device=deviceIdentity(license,deviceKey.address),other=req();
 const send=async(actor,operation,args)=>{const r=await chain.send(actor,operation,args);evidence.transactions.push({operation,hash:r.transactionHash,block:String(r.blockNumber),gas:String(r.gasUsed)});return r;};
 const expiry=BigInt(Math.floor(Date.now()/1000)+600);
 await send(issuer,'registerProduct',[p,issuer]);
 await check('issuer product scope',()=>assert.rejects(send(wrong,'issue',[id,p,owner,expiry,3,true])));
 await send(issuer,'issue',[id,p,owner,expiry,3,true]);
 await check('missing license',()=>assert.rejects(chain.read(randomUUID(),device)));
 await check('wrong owner cannot activate',()=>assert.rejects(send(wrong,'activate',[id,device,1n,req()])));
 const request=req();await send(owner,'activate',[id,device,1n,request]);
 await check('duplicate request and duplicate device preserve count/version',async()=>{const a=await chain.read(license,device);await send(owner,'activate',[id,device,1n,request]);await send(owner,'activate',[id,device,1n,req()]);const b=await chain.read(license,device);assert.equal(b.activeDevices,1);assert.equal(b.version,a.version);});
 await check('request content conflict',()=>assert.rejects(send(owner,'activate',[id,other,1n,request])));
 for(const strategy of ['CENTRALIZED','DIRECT_ONCHAIN','HYBRID']){
  if(strategy==='CENTRALIZED'){
   await db.query('INSERT INTO research.v2_products VALUES($1,$2)',[product,issuer]);
   await centralIssue(license,product,issuer,owner,Number(expiry)*1000,3);
   await centralMutate(license,owner,'activate',device,request,1);
  }
  const verifier=new VerifierV2(chain,strategy,randomUUID(),1000,800);
  const proof=async(prod=product)=>{const c=await verifier.challenge(license,prod,deviceKey.address);return [c.nonce,await deviceKey.signMessage({message:c.message})];};
  const ch=await proof(),issued=await verifier.issue(license,product,deviceKey.address,...ch);
  await check(strategy+' valid proof and token',async()=>{assert.equal((await verifier.verify(license,product,deviceKey.address,issued.token,...await proof())).active,true);});
  await check(strategy+' challenge replay',()=>assert.rejects(verifier.issue(license,product,deviceKey.address,...ch),/REPLAY/));
  await check(strategy+' tampered token',async()=>assert.rejects(verifier.verify(license,product,deviceKey.address,issued.token+'x',...await proof())));
  const badProduct=randomUUID();await check(strategy+' wrong product',async()=>assert.rejects(verifier.issue(license,badProduct,deviceKey.address,...await proof(badProduct)),/PRODUCT/));
  if(strategy==='DIRECT_ONCHAIN')await check('Direct ignores corrupted PostgreSQL membership',async()=>{await db.query('DELETE FROM research.v2_devices WHERE license_id=$1',[license]);assert.equal((await verifier.verify(license,product,deviceKey.address,issued.token,...await proof())).active,true);});
  if(strategy==='HYBRID')await check('Hybrid cache age and known version fence',async()=>{const a=await verifier.observe(license,device);await new Promise(r=>setTimeout(r,30));const b=await verifier.observe(license,device);assert.equal(a.observedAt,b.observedAt);await verifier.invalidate(license,{...b,version:b.version+1});await assert.rejects(verifier.verify(license,product,deviceKey.address,issued.token,...await proof()),/INVALIDATED/);await assert.rejects(verifier.observe(license,device),/CACHE_EPOCH/);});
 }
 await check('deactivation repeat and historical replay do not regrant',async()=>{await send(owner,'deactivate',[id,device]);await send(owner,'deactivate',[id,device]);await send(owner,'activate',[id,device,1n,request]);assert.equal((await chain.read(license,device)).active,false);await send(owner,'activate',[id,device,1n,req()]);assert.equal((await chain.read(license,device)).active,true);});
 await check('concurrent transactions: exact available seats with explicit nonces',async()=>{
  const nonce=await chain.rpc.getTransactionCount({address:owner,blockTag:'pending'});
  const startBlock=await chain.rpc.getBlockNumber({cacheTime:0});
  // Explicit nonces, actual execution order from receipts. Gas supplied so policy reverts are mined.
  const outcomes=await Promise.allSettled(Array.from({length:10},async(_,i)=>{
   const hash=await chain.wallet.writeContract({address:chain.address,abi:chain.abi,functionName:'activate',args:[id,req(),1n,req()],account:owner,chain:chain.wallet.chain,nonce:nonce+i,gas:400000n});
   const receipt=await chain.rpc.waitForTransactionReceipt({hash});evidence.transactions.push({operation:'competing-activate',hash,status:receipt.status,block:String(receipt.blockNumber),index:receipt.transactionIndex,gas:String(receipt.gasUsed)});return receipt.status;
  }));
  for(const result of outcomes)if(result.status==='rejected'){assert.match(result.reason.message,/DEVICE_LIMIT/);evidence.transactions.push({operation:'competing-activate',status:'rpc-revert',reason:'DEVICE_LIMIT'});}
  const endBlock=await chain.rpc.getBlockNumber({cacheTime:0});let mined=0;
  for(let number=startBlock+1n;number<=endBlock;number++){
   const block=await chain.rpc.getBlock({blockNumber:number,includeTransactions:true});
   for(const t of block.transactions)if(t.from.toLowerCase()===owner.toLowerCase()&&t.nonce>=nonce&&t.nonce<nonce+10){const r=await chain.rpc.getTransactionReceipt({hash:t.hash});evidence.transactions.push({operation:'competition-reconciled',nonce:t.nonce,hash:t.hash,status:r.status,gas:String(r.gasUsed),block:String(number)});mined++;}
  }
  assert.equal(mined,10,'Every submitted nonce must have a reconciled mined outcome');
  assert.equal(outcomes.filter(s=>s.status==='fulfilled'&&s.value==='success').length,2);assert.equal((await chain.read(license,device)).activeDevices,3);
 });
 await check('renew and transfer rotate effective membership',async()=>{await send(issuer,'renew',[id,expiry+60n]);await send(owner,'transfer',[id,next]);const s=await chain.read(license,device);assert.equal(s.generation,2);assert.equal(s.active,false);assert.equal(s.activeDevices,0);await assert.rejects(send(owner,'activate',[id,device,1n,request]));await send(next,'activate',[id,device,2n,req()]);});
 await check('revocation terminal, repeat safe, renew forbidden',async()=>{await send(issuer,'revoke',[id]);const a=await chain.read(license,device);await send(issuer,'revoke',[id]);const b=await chain.read(license,device);assert.equal(b.version,a.version);assert.equal(b.active,false);assert.equal(b.activeDevices,0);await assert.rejects(send(issuer,'renew',[id,expiry+120n]));await assert.rejects(send(next,'activate',[id,device,3n,req()]));});
 await check('time-derived expiry, renewal after expiry retains membership',async()=>{
  const l=randomUUID(),i=uuidToBytes16(l),d=deviceIdentity(l,deviceKey.address);
  const block=await chain.rpc.getBlock();
  await send(issuer,'issue',[i,p,owner,block.timestamp+3n,1,true]);await send(owner,'activate',[i,d,1n,req()]);
  await new Promise(r=>setTimeout(r,4100));await chain.rpc.request({method:'evm_mine'});
  await assert.rejects(send(owner,'activate',[i,req(),1n,req()]));
  const expired=await chain.read(l,d);assert.equal(expired.active,true);assert(expired.expiresAt<=Number((await chain.rpc.getBlock()).timestamp)*1000);
  await send(issuer,'renew',[i,(await chain.rpc.getBlock()).timestamp+600n]);assert.equal((await chain.read(l,d)).active,true);
 });
 await check('Centralized concurrency and revoke with unreachable RPC',async()=>{
  const l=randomUUID();await centralIssue(l,product,issuer,owner,Number(expiry)*1000,3);
  const results=await Promise.allSettled(Array.from({length:10},()=>centralMutate(l,owner,'activate',req(),randomUUID(),1)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.equal((await centralSnapshot(l,device)).activeDevices,3);
  const dead=new ChainV2();Object.defineProperty(dead,'rpc',{value:new Proxy({},{get(){throw new Error('RPC_UNAVAILABLE');}})});
  const v=new VerifierV2(dead,'CENTRALIZED',randomUUID());await centralMutate(l,issuer,'revoke','');assert.equal((await v.observe(l,device)).revoked,true);
 });
 await check('Centralized lifecycle matches contract replay and generation policy',async()=>{
  const l=randomUUID(),d=req(),r=randomUUID();await centralIssue(l,product,issuer,owner,Date.now()+600000,1);
  await assert.rejects(centralMutate(l,wrong,'activate',d,r,1),/ACTOR/);
  await centralMutate(l,owner,'activate',d,r,1);await centralMutate(l,owner,'deactivate',d);await centralMutate(l,owner,'deactivate',d);
  await centralMutate(l,owner,'activate',d,r,1);assert.equal((await centralSnapshot(l,d)).active,false);
  await assert.rejects(centralMutate(l,owner,'activate',req(),r,1),/CONFLICT/);
  await centralMutate(l,owner,'activate',d,randomUUID(),1);await centralMutate(l,issuer,'renew',Date.now()+700000);
  await centralMutate(l,owner,'transfer',next);assert.equal((await centralSnapshot(l,d)).generation,2);assert.equal((await centralSnapshot(l,d)).active,false);
  await assert.rejects(centralMutate(l,owner,'activate',d,r,1),/ACTOR/);
  await centralMutate(l,next,'activate',d,randomUUID(),2);await centralMutate(l,issuer,'revoke','');const final=await centralSnapshot(l,d);await centralMutate(l,issuer,'revoke','');assert.equal((await centralSnapshot(l,d)).version,final.version);
  await assert.rejects(centralMutate(l,issuer,'renew',Date.now()+800000),/REVOKED/);
 });
 await check('revocation interleaved with activation leaves no effective device',async()=>{
  const l=randomUUID(),i=uuidToBytes16(l),d=req();await send(issuer,'issue',[i,p,owner,(await chain.rpc.getBlock()).timestamp+600n,1,true]);
  const outcomes=await Promise.allSettled([send(owner,'activate',[i,d,1n,req()]),send(issuer,'revoke',[i])]);
  assert.equal(outcomes[1].status,'fulfilled');
  if(outcomes[0].status==='rejected')assert.match(outcomes[0].reason.message,/GENERATION_CONFLICT|LICENSE_INACTIVE/);
  const final=await chain.read(l,d);assert(final.revoked);assert.equal(final.active,false);assert.equal(final.activeDevices,0);
 });
 evidence.outcome='PASS';
}catch(e){evidence.outcome='FAIL';evidence.error=e.message;throw e;}finally{
 await mkdir('.research-local/evidence',{recursive:true});await writeFile('.research-local/evidence/protocol-v2-'+Date.now()+'.json',json(evidence));await db.end();redis.disconnect();
}
