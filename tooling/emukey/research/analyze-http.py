"""Analyze recorded requests, never synthesize benchmark observations."""
import argparse,collections,hashlib,json,math,pathlib,random,statistics
p=argparse.ArgumentParser();p.add_argument('directory',type=pathlib.Path);a=p.parse_args();folder=a.directory
checks=json.loads((folder/'checksums.json').read_text())
for name,expected in checks.items():
 if pathlib.Path(name).name!=name:raise ValueError('Invalid manifest path')
 assert hashlib.sha256((folder/name).read_bytes()).hexdigest()==expected, 'Checksum mismatch '+name
def percentile(values,q):
 return sorted(values)[max(0,math.ceil(len(values)*q)-1)] if values else None
runs=[]
for f in sorted(folder.glob('*.ndjson')):
 rows=[json.loads(s) for s in f.read_text(encoding='utf-8').splitlines() if s.strip()]
 manifests=[r for r in rows if r['type']=='manifest'];end=next((r for r in reversed(rows) if r['type']=='end'),{})
 if not manifests:
  runs.append({'file':f.name,'state':end.get('state','INCOMPLETE'),'unusable':True});continue
 m=manifests[0];samples=[r for r in rows if r['type']=='sample'];counts=dict(collections.Counter(r['decision'] for r in samples));lat=[r['latencyMs'] for r in samples if 'latencyMs' in r and r['decision']!='TIMEOUT']
 by_result={k:{'n':len(v),'p50Ms':percentile(v,.5),'p95Ms':percentile(v,.95),'p99Ms':percentile(v,.99)} for k in counts for v in [[r['latencyMs'] for r in samples if r['decision']==k and 'latencyMs' in r]]}
 resources=[r for r in rows if r['type']=='resource'];cpu={}
 for scope in ['server','generator']:
  series=[]
  for first,last in zip(resources,resources[1:]):
   x,y=first[scope],last[scope];dt=y['at']-x['at'];delta=sum(y['cpu'].values())-sum(x['cpu'].values())
   if dt>0 and delta>=0:series.append(100*delta/(dt*1000))
  cpu[scope]={'cpuPercentOneCoreMean':statistics.mean(series) if series else None,'maxRssBytes':max((r[scope]['memory']['rss'] for r in resources),default=None),'resourceSamples':len(resources)}
 duration=end.get('elapsedMs');runs.append({'file':f.name,'session':m['session'],'strategy':m['strategy'],'repetition':m['repetition'],'seed':m['seed'],'state':end.get('state','INCOMPLETE'),'counts':counts,'sampleCount':len(samples),'p50Ms':percentile(lat,.5),'p95Ms':percentile(lat,.95),'p99Ms':percentile(lat,.99),'byDecision':by_result,'maxDispatchLagMs':max((r.get('lagMs',0) for r in samples),default=None),'responseRps':sum(1 for r in samples if r.get('responseReceived',r['decision'] in ['ALLOW','DENY']))/(duration/1000) if duration else None,'resources':cpu,'warnings':['P99 descriptive below 10000 observations'] if len(lat)<10000 else []})
paired=[];strategies=sorted({r.get('strategy') for r in runs if r.get('strategy')});rng=random.Random(2026)
for i,s in enumerate(strategies):
 for t in strategies[i+1:]:
  left={r['seed']:r for r in runs if r.get('strategy')==s and r['state']=='COMPLETED' and r['p95Ms'] is not None};right={r['seed']:r for r in runs if r.get('strategy')==t and r['state']=='COMPLETED' and r['p95Ms'] is not None}
  diffs=[left[k]['p95Ms']-right[k]['p95Ms'] for k in sorted(left.keys()&right.keys())]
  boot=[statistics.mean(rng.choices(diffs,k=len(diffs))) for _ in range(10000)] if len(diffs)>=2 else []
  paired.append({'left':s,'right':t,'metric':'paired run p95 difference ms','pairs':len(diffs),'meanDifferenceMs':statistics.mean(diffs) if diffs else None,'bootstrap95':[percentile(boot,.025),percentile(boot,.975)] if boot else None,'warning':'run-level bootstrap; small run count limits inference; no superiority claim'})
result={'runs':runs,'paired':paired,'resourceBoundary':'API and generator only; CPU percent uses one logical core=100%; excludes node/database/cache and host totals','timeoutPolicy':'timeouts retained separately; completed-response quantiles exclude censored timeout durations','performanceClaim':False}
target=folder/'analysis.json'
with target.open('x',encoding='utf-8') as f:json.dump(result,f,ensure_ascii=False,indent=2)
print(json.dumps({'runs':len(runs),'output':str(target)}))
