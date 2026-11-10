"""Destructive only to the dedicated research-local EVM test run. No mainnet path."""
import json,time,urllib.request,http.cookiejar,pathlib
root=pathlib.Path(__file__).resolve().parents[3]
base='http://127.0.0.1:3100/api/research'
session=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def api(path,body=None):
 return json.load(session.open(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})))
def rpc(method,params=[]):
 result=json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:58545',data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'Content-Type':'application/json'})))
 if 'error' in result:raise RuntimeError(result['error'])
 return result['result']
assert int(rpc('eth_chainId'),16)==31337
api('/login',json.loads((root/'EmuKey/backend/.research-local/login.json').read_text()))
assert not any(r['state'] in ['QUEUED','PREPARING','WARMING','RUNNING','REVOKING','OBSERVING'] for r in api('/runs')),'Run this test alone'
snapshot=rpc('evm_snapshot')
run=api('/runs',{'name':'Reorg rejection verification','observeMs':15000})
api('/runs/'+run['id']+'/start',{})
for _ in range(100):
 result=api('/runs/'+run['id'])
 if result['run']['state']=='OBSERVING':break
 time.sleep(.2)
assert result['run']['state']=='OBSERVING'
assert rpc('evm_revert',[snapshot]) is True
for _ in range(100):
 result=api('/runs/'+run['id'])
 if result['run']['state']=='FAILED':break
 time.sleep(.2)
assert result['run']['state']=='FAILED'
assert 'INVALID_FOR_ANALYSIS' in result['run']['error']
assert any(e['kind']=='INVALID_FOR_ANALYSIS' for e in result['events'])
print('PASS: local chain reverted after confirmation; run FAILED / INVALID_FOR_ANALYSIS, partial evidence retained. Run '+run['id'])
