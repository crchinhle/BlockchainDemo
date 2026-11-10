"""Independent stdlib re-analysis of immutable JSON export (no app imports)."""
import json,sys,hashlib,math
data=json.load(open(sys.argv[1],encoding='utf8'))
errors=[]
for rep in data['repetitions']:
 samples=[s for s in data['samples'] if s['repetition_id']==rep['id']]
 if not rep.get('summary'):continue
 reference={e['data']['licenseId']:int(e['at']) for e in data['events'] if e['kind']=='confirmed' and e['repetition_id']==rep['id']}
 stale=[s for s in samples if s['decision']=='ALLOW' and s.get('licenseId') in reference and s['decisionStartedAt']>=reference[s['licenseId']] and s['decisionEvaluatedAt']>=reference[s['licenseId']]]
 if len(samples)!=rep['summary']['sampleCount']:errors.append('sampleCount mismatch')
 if len(stale)!=rep['summary']['staleAccepts']:errors.append('staleAccepts mismatch')
 lat=sorted(s['latencyMs'] for s in samples if s['decision']!='DROPPED')
 for label,p in [('p50Ms',.5),('p95Ms',.95),('p99Ms',.99)]:
  value=lat[max(0,math.ceil(len(lat)*p)-1)] if lat else None
  if value!=rep['summary'][label]:errors.append(label+' mismatch')
 print(json.dumps({'repetition':rep['id'],'samples':len(samples),'staleAccepts':len(stale),'state':rep['state']}))
if errors:raise SystemExit('; '.join(errors))
print('Independent analysis: PASS. Hash verification is performed by the JS test using RFC8785 canonical JSON number serialization.')
