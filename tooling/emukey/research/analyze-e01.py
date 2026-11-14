"""Offline E01 analysis. Standard library only; no inferred or synthetic observations."""
import collections,csv,hashlib,itertools,json,math,pathlib,statistics,sys
root=pathlib.Path(sys.argv[1]);m=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
tables=root/'tables';tables.mkdir(exist_ok=True);figures=root/'figures';figures.mkdir(exist_ok=True)
def write(name,rows):
 with (tables/(name+'.csv')).open('w',encoding='utf-8',newline='') as f:
  w=csv.DictWriter(f,fieldnames=list(dict.fromkeys(k for r in rows for k in r)) or ['no_data']);w.writeheader();w.writerows(rows)
def quant(v,q=.95):return sorted(v)[max(0,math.ceil(len(v)*q)-1)] if v else None
def stats(v):
 v=[x for x in v if x is not None]
 return {'n':len(v),'median':statistics.median(v) if v else None,'min':min(v) if v else None,'max':max(v) if v else None}
http=[];rev=[];life=[];reasons=[];checks=[];inventory=[]
for a in m['attempts']:
 inventory.append({**{k:a.get(k) for k in ['id','group','smoke','attempt','state','path','retryOf','startedAt','finishedAt','exitCode']},'validation_reason':a.get('validation',{}).get('reason')})
 if a['state']!='VALID' or a['smoke']:continue
 rr=[json.loads(line) for p in sorted((root/a['path']).glob('*.ndjson')) for line in p.read_text(encoding='utf-8').splitlines() if line.strip()]
 c=a['config'];end=[x for x in rr if x['type']=='end'];checks.append({'run':a['id'],'check':'completed','passed':len(end)==1 and end[0]['state']=='COMPLETED'})
 if a['group']=='http':
  ss=[x for x in rr if x['type']=='sample'];cnt=collections.Counter(x['decision'] for x in ss);responses=[x for x in ss if x.get('responseReceived')];allows=[x for x in ss if x['decision']=='ALLOW'];sent=len(ss)-cnt['DROPPED'];elapsed=end[0]['elapsedMs'];expected=c['rate']*c['durationMs']//1000
  schedule=[(x['sequence'],x['index'],round(x['sequence']*1000/c['rate'],6)) for x in sorted(ss,key=lambda x:x['sequence'])]
  sh=hashlib.sha256(json.dumps(schedule).encode()).hexdigest()
  r={'run':a['id'],'raw':a['path'],'strategy':c['strategies'][0],'cache_ms':c['cacheMs'] if c['strategies'][0]=='HYBRID' else None,'snapshot_freshness_ms':c['cacheMs'],'token_ms':c['tokenMs'],'rate':c['rate'],'seed':c['seed'],'scheduled':expected,'dropped':cnt['DROPPED'],'sent':sent,'allow':cnt['ALLOW'],'deny':cnt['DENY'],'timeout':cnt['TIMEOUT'],'technical_error':cnt['ERROR'],'responses':len(responses),'configured_measurement_ms':c['durationMs'],'elapsed_with_drain_ms':elapsed,'response_per_s':len(responses)*1000/elapsed,'allow_per_s':len(allows)*1000/elapsed,'allow_per_configured_s':len(allows)*1000/c['durationMs'],'allow_scheduled_ratio':len(allows)/expected,'allow_sent_ratio':len(allows)/sent if sent else None,'p95_response_ms':quant([x['latencyMs'] for x in responses]),'p95_response_n':len(responses),'p95_allow_ms':quant([x['latencyMs'] for x in allows]),'p95_allow_n':len(allows),'rpc_read_attempts':sum(x.get('metrics',{}).get('rpcCalls',0) for x in ss),'rpc_observed_ops_denominator':sum('metrics' in x for x in ss),'rpc_sent_ops_denominator':sent,'schedule_sha256':sh}
  http.append(r)
  checks.extend([{'run':a['id'],'check':'scheduled=dropped+sent','passed':expected==len(ss)==cnt['DROPPED']+sent and len(set(x['sequence'] for x in ss))==expected},{'run':a['id'],'check':'sent=terminal_outcomes','passed':sent==sum(cnt[k] for k in ['ALLOW','DENY','TIMEOUT','ERROR'])},{'run':a['id'],'check':'timestamps','passed':all(x.get('endedAt',0)>=x.get('startedAt',0) for x in ss)}])
  reason_counts=collections.Counter()
  for x in ss:
   t=x.get('trace') or {};i=t.get('issue') or {};v=t.get('verify') or {};signed=i.get('tokenIssuedAtMs');deadline=i.get('tokenDeadlineMs');checked=v.get('tokenCheckedAtMs');cause=(v or i).get('cause')
   expiry='undetermined' if x['decision'] in ['TIMEOUT','ERROR'] or (x['decision']=='DENY' and not cause) else 'not_expiry_denial'
   if cause=='TOKEN_EXPIRED':
    expiry='undetermined'
    if signed is not None and deadline is not None:
     if signed>=deadline:expiry='expired_at_sign_completion'
     elif checked is not None and checked>=deadline:expiry='valid_at_sign_expired_at_check'
   reason_counts[(x['decision'],x.get('reason',''),expiry)]+=1
   life.append({'run':a['id'],'sequence':x['sequence'],'decision':x['decision'],'snapshot_read_start_ms':i.get('snapshotObservedAtMs'),'issuance_anchor_ms':i.get('issuanceAnchorAtMs'),'sign_completed_ms':signed,'internal_D_ms':deadline,'checked_ms':checked,'expiry_class':expiry,'cause':cause})
  for (decision,reason,expiry),n in reason_counts.items():reasons.append({'run':a['id'],'decision':decision,'reason':reason,'expiry_class':expiry,'count':n,'scheduled_denominator':expected,'sent_denominator':sent})
 else:
  ref=next(x for x in rr if x['type']=='revocation');tc=ref['referenceAt'];fault=next(x for x in rr if x['type']=='fault-evidence');applied=[x for x in rr if x['type']=='version-applied' and (x.get('revoked') or x.get('path')=='event')];detect=[x['detectedAt'] for x in applied]+[x['detectedAt'] for x in rr if x['type']=='detection' and x['state']['revoked']]
  base={'run':a['id'],'raw':a['path'],'cache_ms':c['cacheMs'],'token_ms':c['tokenMs'],'seed':c['seed'],'event':'dropped' if c['dropEvents'] else 'delivered','offset_ms':c['offsetMs'],'scheduled_ms':ref['scheduledAt'],'submitted_ms':ref['submittedAt'],'confirmed_ms':tc,'schedule_to_submit_ms':ref['submittedAt']-ref['scheduledAt'],'synchronization_detected_after_confirm_ms':min(detect)-tc if detect else None,'synchronization_applied_after_confirm_ms':min(x['appliedAt'] for x in applied)-tc if applied else None,'observation_end_ms':fault['observationEndAt'],'dropped_logs':fault['droppedLogs'],'load':'isolated verifier probes; no HTTP background load'}
  policy_denies=[x for x in rr if x['type']=='sample' and x.get('reason')=='LICENSE_INACTIVE' and x['startedAt']>=tc]
  first_policy=min(policy_denies,key=lambda x:x['decisionAt']) if policy_denies else None
  base['request_path_detection_lower_ms']=(first_policy.get('metrics',{}).get('trace',{}).get('snapshotObservedAtMs',first_policy['startedAt'])-tc) if first_policy else None
  base['request_path_detection_upper_ms']=first_policy['decisionAt']-tc if first_policy else None
  known_uppers=([min(detect)-tc] if detect else [])+([first_policy['decisionAt']-tc] if first_policy else [])
  base['first_detection_upper_ms']=min(known_uppers) if known_uppers else None
  applied_uppers=([min(x['appliedAt'] for x in applied)-tc] if applied else [])+([first_policy['decisionAt']-tc] if first_policy else [])
  base['first_version_application_upper_ms']=min(applied_uppers) if applied_uppers else None
  base['detection_note']='synchronization timestamps exact at harness boundaries; request-path detection interval inferred from snapshot read start and LICENSE_INACTIVE response; license expiry outside observation window'
  checks.append({'run':a['id'],'check':'precondition and event mode','passed':any(x['type']=='precondition' and x['bothAllowed'] for x in rr) and (not c['dropEvents'] or fault['droppedLogs']>0)})
  for cohort in ['old-token','refresh']:
   ss=sorted([x for x in rr if x['type']=='sample' and x['cohort']==cohort and x['startedAt']>=tc],key=lambda x:x['startedAt']);al=[x for x in ss if x['decision']=='ALLOW'];last=max((x['decisionAt'] for x in al),default=None)
   deny=next((x for x in ss if x['decision']=='DENY' and (last is None or x['startedAt']>last)),None)
   stable=next((x for j,x in enumerate(ss) if x['decision']=='DENY' and all(y['decision']=='DENY' for y in ss[j:])),None)
   intervals=[b['startedAt']-a['startedAt'] for a,b in zip(ss,ss[1:])]
   status='no_allow_observed' if not al else 'right_censored' if ss[-1]['decision']=='ALLOW' else 'transition_observed' if stable else 'indeterminate'
   rev.append({**base,'cohort':cohort,'probes':len(ss),'allow_after_confirm':len(al),'last_allow_ms':last-tc if last is not None else None,'next_deny_ms':deny['decisionAt']-tc if deny else None,'stable_deny_ms':stable['decisionAt']-tc if stable else None,'status':status,'technical_errors':sum(x['decision']=='ERROR' for x in ss),'access_attempts':sum(x['accessAttempted'] for x in ss),'access_allows':sum(x['accessAttempted'] and x['decision']=='ALLOW' for x in ss),'access_denies':sum(x['accessAttempted'] and x['decision']=='DENY' for x in ss),'next_deny_stage':('verify' if deny['accessAttempted'] else 'issue') if deny else None,'first_access_deny_ms':next((x['decisionAt']-tc for x in ss if x['accessAttempted'] and x['decision']=='DENY'),None),'issue_allows':sum(x['issuance'].get('decision')=='ALLOW' for x in ss),'issue_denies':sum(x['issuance'].get('decision')=='DENY' for x in ss),'last_probe_ms':ss[-1]['decisionAt']-tc if ss else None,**{'probe_interval_'+k+'_ms':v for k,v in stats(intervals).items()}})
def grouped(rows,fields,metrics):
 result=[]
 for key in sorted(set(tuple(r[k] for k in fields) for r in rows),key=str):
  group=[r for r in rows if tuple(r[k] for k in fields)==key];result.append({**dict(zip(fields,key)),'runs':len(group),**{metric+'_'+k:v for metric in metrics for k,v in stats([r[metric] for r in group]).items()}})
 return result
hs=grouped(http,['strategy','cache_ms','token_ms','rate'],['allow_per_s','response_per_s','allow_scheduled_ratio','allow_sent_ratio','p95_response_ms','p95_allow_ms'])
rs=grouped(rev,['cache_ms','token_ms','event','cohort'],['last_allow_ms','next_deny_ms','stable_deny_ms','synchronization_detected_after_confirm_ms','first_detection_upper_ms','synchronization_applied_after_confirm_ms','first_version_application_upper_ms'])
for r in rs:
 g=[x for x in rev if all(x[k]==r[k] for k in ['cache_ms','token_ms','event','cohort'])]
 for status in ['no_allow_observed','right_censored','transition_observed','indeterminate']:r[status+'_n']=sum(x['status']==status for x in g)
paired=[]
for key in set((r['seed'],r['rate']) for r in http):
 g=[r for r in http if (r['seed'],r['rate'])==key]
 checks.append({'run':str(key),'check':'paired_input_schedule','passed':len(g)==12 and len(set(r['schedule_sha256'] for r in g))==1})
 for left,right in itertools.combinations(sorted(g,key=lambda r:(r['strategy'],r['cache_ms'] or 0,r['token_ms'])),2):
  paired.append({'seed':key[0],'rate':key[1],'left_strategy':left['strategy'],'right_strategy':right['strategy'],'left_cache_ms':left['cache_ms'],'right_cache_ms':right['cache_ms'],'left_token_ms':left['token_ms'],'right_token_ms':right['token_ms'],'left':left['run'],'right':right['run'],'allow_per_s_left_minus_right':left['allow_per_s']-right['allow_per_s'],'allow_ratio_left_minus_right':left['allow_scheduled_ratio']-right['allow_scheduled_ratio']})
write('paired-summary',grouped(paired,['rate','left_strategy','right_strategy','left_cache_ms','right_cache_ms','left_token_ms','right_token_ms'],['allow_per_s_left_minus_right','allow_ratio_left_minus_right']))
paper=[]
for h in hs:
 if h['strategy']!='HYBRID':continue
 for r in rs:
  if (r['cache_ms'],r['token_ms'])==(h['cache_ms'],h['token_ms']):paper.append({**h,**{'revocation_'+k:v for k,v in r.items() if k not in ['cache_ms','token_ms']},'revocation_load':'isolated probes, not HTTP rate shown'})
counts={'hybrid':sum(x['strategy']=='HYBRID' for x in http),'direct':sum(x['strategy']=='DIRECT_ONCHAIN' for x in http),'revocation':len(set(x['run'] for x in rev))}
tradeoffs=[]
for h in http:
 if h['strategy']!='HYBRID':continue
 baseline=next((x for x in http if x['strategy']=='HYBRID' and x['cache_ms']==1000 and x['token_ms']==800 and x['seed']==h['seed'] and x['rate']==h['rate']),None)
 if baseline is None:continue
 for r in rev:
  if (r['cache_ms'],r['token_ms'],r['seed'])!=(h['cache_ms'],h['token_ms'],h['seed']):continue
  rb=next((x for x in rev if x['cache_ms']==1000 and x['token_ms']==800 and x['seed']==h['seed'] and x['event']==r['event'] and x['cohort']==r['cohort']),None)
  if rb is None:continue
  tradeoffs.append({'cache_ms':h['cache_ms'],'token_ms':h['token_ms'],'rate':h['rate'],'seed':h['seed'],'event':r['event'],'cohort':r['cohort'],'baseline_cache_ms':1000,'baseline_token_ms':800,'allow_per_s_difference':h['allow_per_s']-baseline['allow_per_s'],'last_allow_ms_difference':r['last_allow_ms']-rb['last_allow_ms'] if r['last_allow_ms'] is not None and rb['last_allow_ms'] is not None else None,'next_deny_ms_difference':r['next_deny_ms']-rb['next_deny_ms'] if r['next_deny_ms'] is not None and rb['next_deny_ms'] is not None else None,'status':r['status'],'baseline_status':rb['status']})
write('tradeoffs-paired',tradeoffs)
write('tradeoffs-summary',grouped(tradeoffs,['cache_ms','token_ms','rate','event','cohort'],['allow_per_s_difference','last_allow_ms_difference','next_deny_ms_difference']))
for k,n in [('hybrid',135),('direct',45),('revocation',90)]:checks.append({'run':k,'check':'expected_count','passed':counts[k]==n})
for name,data in [('http-runs',http),('http-summary',hs),('revocation-runs',rev),('revocation-summary',rs),('paper-table',paper),('paired-seeds',paired),('token-timestamps',life),('outcomes-by-reason',reasons),('attempt-inventory',inventory),('checks',checks)]:write(name,data)
# Simple standalone SVG plot from measured run aggregates, without external packages.
parts=['<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="620"><rect width="1100" height="620" fill="white"/><text x="40" y="30" font-size="19">E01: allowed operations/s (median; min-max across seeds)</text>']
colors={800:'#2563eb',1000:'#16a34a',2000:'#dc2626'}
for panel,rate in enumerate([25,50,100]):
 x0=70+panel*355;parts.append(f'<text x="{x0}" y="65">Offered load {rate} ops/s</text>')
 for y in range(0,101,20):parts.append(f'<path d="M{x0},{530-y*4.3}h270" stroke="#ddd"/><text x="{x0-30}" y="{534-y*4.3}">{y}</text>')
 for token,color in colors.items():
  g=sorted([r for r in hs if r['strategy']=='HYBRID' and r['rate']==rate and r['token_ms']==token],key=lambda r:r['cache_ms']);points=[]
  for r in g:
   x=x0+[1000,2000,5000].index(r['cache_ms'])*110+20;y=530-r['allow_per_s_median']*4.3;points.append(f'{x},{y}');parts.append(f'<path d="M{x},{530-r["allow_per_s_min"]*4.3}V{530-r["allow_per_s_max"]*4.3}" stroke="{color}"/><circle cx="{x}" cy="{y}" r="4" fill="{color}"/>')
  parts.append(f'<polyline points="{" ".join(points)}" fill="none" stroke="{color}"/>')
 for i,cache in enumerate([1,2,5]):parts.append(f'<text x="{x0+20+i*110}" y="555">{cache}s</text>')
parts.append('<text x="50" y="595">Cache: 1/2/5 s. Token: blue 0.8 s; green 1 s; red 2 s. Throughput denominator includes drain.</text></svg>')
(figures/'http-throughput.svg').write_text(''.join(parts),encoding='utf-8')
parts=['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="white"/><text x="30" y="30" font-size="18">E01 revocation: last allow to next deny; isolated probes</text><text x="30" y="55">Each point is one independent revocation. Hollow circle: no post-confirmation allow observed.</text>']
for j,r in enumerate(rs):
 y=90+j*29;parts.append(f'<text x="10" y="{y+4}" font-size="11">C={r["cache_ms"]} T={r["token_ms"]} {r["event"]} {r["cohort"]}</text>')
 g=[x for x in rev if all(x[k]==r[k] for k in ['cache_ms','token_ms','event','cohort'])]
 for i,x in enumerate(g):
  yy=y+(i-2)*3;lo=x['last_allow_ms'];hi=x['next_deny_ms'];xx=320+(lo or 0)*.14
  if hi is not None:parts.append(f'<path d="M{xx},{yy}H{320+hi*.14}" stroke="#2563eb"/>')
  parts.append(f'<circle cx="{xx}" cy="{yy}" r="2.5" fill="{"white" if lo is None else "#2563eb"}" stroke="#2563eb"/>')
for seconds in range(0,6):
 x=320+seconds*140;parts.append(f'<text x="{x}" y="1165">{seconds}s</text>')
parts.append('</svg>');(figures/'revocation-intervals.svg').write_text(''.join(parts),encoding='utf-8')
result={'counts':counts,'checks':len(checks),'failed_checks':[r for r in checks if not r['passed']]};(root/'analysis-validation.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
def fmt(v):return 'chưa có dữ liệu' if v is None else f'{v:.3f}'
report=['# Kết quả E01',f"Lượt hợp lệ: Hybrid {counts['hybrid']}/135; trực tiếp trên chuỗi {counts['direct']}/45; sự kiện thu hồi {counts['revocation']}/90.",'','Số dưới đây là trung vị [nhỏ nhất; lớn nhất] trên các seed độc lập. Thông lượng dùng thời gian đo thực gồm drain. Không gộp smoke hoặc dữ liệu cũ.','', '## HTTP ở tải đặt 100 thao tác/giây','','| Chiến lược | Cache (ms) | Token (ms) | Lượt | Cho phép/s | Tỷ lệ cho phép trên lịch |','|---|---:|---:|---:|---|---|']
for r in hs:
 if r['rate']==100:report.append(f"| {r['strategy']} | {r['cache_ms'] if r['cache_ms'] is not None else 'không áp dụng'} | {r['token_ms']} | {r['runs']} | {fmt(r['allow_per_s_median'])} [{fmt(r['allow_per_s_min'])}; {fmt(r['allow_per_s_max'])}] | {fmt(r['allow_scheduled_ratio_median'])} [{fmt(r['allow_scheduled_ratio_min'])}; {fmt(r['allow_scheduled_ratio_max'])}] |")
report+=['','## Thu hồi với cùng cặp cache/token','','Phép này dùng bộ dò riêng, không chạy dưới tải HTTP nói trên. Mỗi dòng có tối đa 5 sự kiện độc lập. Hai cohort thuộc cùng sự kiện không phải hai lần lặp độc lập. Thời gian tính từ xác nhận giao dịch. Không thấy allow sau xác nhận không được thay bằng thời điểm allow cuối bằng 0.','', '| Cache/token (ms) | Sự kiện | Nhóm | Lượt | Allow cuối (ms), chỉ các lượt có allow | Không thấy allow | Còn allow ở cuối |','|---|---|---|---:|---|---:|---:|']
for r in rs:report.append(f"| {r['cache_ms']}/{r['token_ms']} | {r['event']} | {r['cohort']} | {r['runs']} | {fmt(r['last_allow_ms_median'])} [{fmt(r['last_allow_ms_min'])}; {fmt(r['last_allow_ms_max'])}], n={r['last_allow_ms_n']} | {r['no_allow_observed_n']} | {r['right_censored_n']} |")
report+=['','## Đọc đánh đổi và giới hạn','','tables/tradeoffs-paired.csv giữ chênh lệch theo cùng seed so với cache 1 giây/token 0,8 giây; tradeoffs-summary.csv giữ trung vị/min/max của các chênh lệch. Ô trống về allow cuối là không đủ quan sát để lấy hiệu, không phải hiệu bằng 0. paired-summary.csv mở rộng các cặp cấu hình HTTP còn lại. Không chọn một cấu hình tốt nhất cho mọi điều kiện.','','Mốc đồng bộ event/poll được ghi trực tiếp. Với đường đọc snapshot trong yêu cầu, thời điểm phát hiện và cập nhật phiên bản chỉ xác định trong khoảng từ bắt đầu đọc đến phản hồi LICENSE_INACTIVE; các cột *_upper_ms là cận trên quan sát, không phải mốc chính xác. next_deny_stage tách từ chối cấp token khỏi từ chối truy cập thực.','','Một máy local, một đợt chạy, năm seed; không chứng minh cận bảo đảm hoặc suy rộng mainnet. Không cách ly CPU toàn máy. Đối chứng không cache nhưng giữ giới hạn tuổi snapshot 5 giây theo quy tắc hiện có. Thông lượng là toàn luồng cấp-và-xác minh HTTP, không phải riêng một endpoint. RPC chỉ bao phủ phần đường yêu cầu có telemetry.','','## Kiểm tra chất lượng',f"Số kiểm tra: {len(checks)}; chưa đạt: {len(result['failed_checks'])}.",'Lượt lỗi và liên kết chạy lại: tables/attempt-inventory.csv. Tất cả thiếu dữ liệu/timeout/lỗi kỹ thuật được giữ, không điền số đo giả.']
(root/'KET_QUA_E01.md').write_text('\n'.join(report)+'\n',encoding='utf-8');print(json.dumps(result))
