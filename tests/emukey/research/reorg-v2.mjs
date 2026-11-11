// Isolated ephemeral EVM: never revert the user's running chain or Docker data.
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const url='http://127.0.0.1:58546';
try{await fetch(url,{signal:AbortSignal.timeout(500)});throw new Error('ISOLATED_PORT_OCCUPIED');}catch(e){if(e.message==='ISOLATED_PORT_OCCUPIED')throw e;}
const child=spawn(process.execPath,[resolve('contracts/node_modules/hardhat/dist/src/cli.js'),'node','--hostname','127.0.0.1','--port','58546'],{cwd:resolve('contracts'),windowsHide:true,stdio:'ignore'});
let db,redis;
try{
 for(let i=0;i<100;i++){try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});if((await r.json()).result==='0x7a69')break;}catch{}await new Promise(r=>setTimeout(r,100));}
 process.env.RESEARCH_RPC_URL=url;
 const infra=await import('../../../EmuKey/backend/dist/modules/research/infrastructure.js');db=infra.db;redis=infra.redis;await infra.initialize();
 const {ChainV2,VerifierV2}=await import('../../../EmuKey/backend/dist/modules/research/protocol-v2.js');
 const {uuidToBytes16}=await import('../../../EmuKey/backend/dist/platform/crypto/license-crypto.js');
 const chain=new ChainV2('v2-isolated-reorg:'+randomUUID());await chain.init(true);
 const license=randomUUID(),product=randomUUID(),id=uuidToBytes16(license),p=uuidToBytes16(product),expiry=(await chain.rpc.getBlock()).timestamp+600n;
 await chain.send(chain.signer,'registerProduct',[p,chain.signer]);await chain.send(chain.signer,'issue',[id,p,chain.owner,expiry,1,true]);
 const point=await chain.rpc.request({method:'evm_snapshot'});
 await chain.send(chain.signer,'renew',[id,expiry+60n]);
 const v=new VerifierV2(chain,'HYBRID',randomUUID());const cursor=randomUUID();await v.synchronize([license],cursor);
 assert.equal(await chain.rpc.request({method:'evm_revert',params:[point]}),true);await chain.rpc.request({method:'evm_mine'});
 await assert.rejects(v.synchronize([license],cursor),/REORG_CHECKPOINT/);
 assert.equal(await redis.get(v.key(license)+':unsafe'),'1');
 console.log('PASS isolated chain 31337 checkpoint reorg detected; unsafe fence persisted; primary chain untouched');
}finally{child.kill();if(db)await db.end();if(redis)redis.disconnect();}
