"""Package only public E01 evidence, then extract and reproduce all tables."""
import datetime,hashlib,json,pathlib,re,shutil,subprocess,sys,tempfile,zipfile
root=pathlib.Path(sys.argv[1]).resolve();repo=pathlib.Path(__file__).resolve().parents[3]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
validation=json.loads((root/'analysis-validation.json').read_text())
if validation['failed_checks']:raise RuntimeError('Measurements incomplete; no final ZIP')
# Run functional checks only after measurement, so they do not contend with trials.
checkdir=root/'checks';checkdir.mkdir(exist_ok=True)
check_results=[]
for name,args,cwd in [
 ('domain',['node','--test','tests/emukey/research/domain.test.mjs'],repo),
 ('protocol-v2',['node',str(repo/'tests/emukey/research/protocol-v2.mjs')],repo/'EmuKey/backend'),
 ('http-functional',['node','tests/emukey/research/http-load.mjs'],repo),
]:
 log=checkdir/(name+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%S%f')+'.log')
 with log.open('wb') as f:result=subprocess.run(args,cwd=cwd,stdout=f,stderr=subprocess.STDOUT,timeout=240)
 check_results.append({'name':name,'exitCode':result.returncode,'log':log.relative_to(root).as_posix()})
 (checkdir/'results.json').write_text(json.dumps(check_results,indent=2),encoding='utf-8')
 if result.returncode:raise RuntimeError('Functional check failed: '+name)
scripts=root/'scripts';scripts.mkdir(exist_ok=True)
for name in ['e01-run.mjs','e01-revocation.mjs','http-load.mjs','analyze-e01.py','package-e01.py','Run-E01.ps1']:
 shutil.copy2(repo/'tooling/emukey/research'/name,scripts/name)
paths=['EmuKey/backend/src/modules/research/protocol-v2.ts','EmuKey/backend/src/modules/research/http-benchmark.ts','tooling/emukey/research/http-load.mjs','tests/emukey/research/protocol-v2.mjs']
(scripts/'source.patch').write_bytes(subprocess.check_output(['git','diff','--',*paths],cwd=repo))
for path in paths+['EmuKey/backend/package.json','EmuKey/backend/pnpm-lock.yaml','EmuKey/frontend/package.json','EmuKey/frontend/pnpm-lock.yaml','docs/research/model-v2.md','docs/research/model-alignment.md','EmuKey/backend/contracts/solidity/ResearchLicenseRegistryV2.sol','EmuKey/backend/contracts/artifacts/solidity/ResearchLicenseRegistryV2.sol/ResearchLicenseRegistryV2.json']:
 source=repo/path
 if source.is_file():
  target=scripts/'reference'/path;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
m=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
for path,expected in m['sourceHashes'].items():
 if sha(repo/path)!=expected:raise RuntimeError('Measurement source changed: '+path)
subprocess.run([sys.executable,str(scripts/'analyze-e01.py'),str(root)],check=True)
validation=json.loads((root/'analysis-validation.json').read_text())
if validation['failed_checks']:raise RuntimeError('E01 validation failed; preserve incomplete evidence, do not deliver as completed')
readme='''# E01 — dữ liệu đo local cho bài báo

Commit nền: {commit}. Mọi thay đổi đang dùng so với commit nằm trong scripts/source.patch; mã công cụ mới và bản nguồn tham chiếu nằm trong scripts/. Không sửa hoặc gộp hai bộ dữ liệu cũ.

Đủ 135 lượt Hybrid, 45 lượt DIRECT_ONCHAIN và 90 sự kiện thu hồi độc lập. Smoke nằm riêng theo trường smoke trong manifest; các attempt lỗi/dở và liên kết retryOf được giữ nguyên. Không loại lượt chỉ vì hiệu năng thấp.

## Phương pháp

HTTP: cache 1/2/5 s × token 0,8/1/2 s; tải đặt 25/50/100 thao tác/s; 10 giấy phép, phân bố 80/20; warmup 2 s, lịch đo 20 s, concurrency 64; seed 4101–4105. Một thao tác gồm challenge, ký proof, cấp token, challenge, ký proof và xác minh qua HTTP. Thứ tự thực tế có trong manifest.attempts; cùng seed/rate có cùng lịch chỉ số giấy phép. Khóa mật mã ngẫu nhiên mới không do seed sinh.

Mã v2 có D=min(mốc cấp+tokenMs, mốc bắt đầu đọc snapshot+cacheMs, hạn license). Không có giới hạn freshness độc lập: nó bằng cacheMs. Cache hiệu dụng Hybrid vì thế là 1/2/5 s; hạn token có thể ngắn hơn cấu hình. DIRECT_ONCHAIN không dùng cache, nhưng quy tắc hạn snapshot vẫn tồn tại: cố định 5 s cho đối chứng để không cắt token 2 s xuống 1 s. Chính sách xác minh và kiểm tra chữ ký không thay đổi. server.verifierTiming ghi cấu hình; snapshotObservedAtMs là mốc trước RPC của bản chụp, kể cả snapshot được dùng lại từ cache.

Thông lượng chính dùng thời gian thực từ đầu lịch đến khi hoàn tất tất cả thao tác đã gửi (gồm drain). Cột allow_per_configured_s dùng 20 s, chỉ là tổng hoàn tất chia độ dài lịch. Không diễn giải hai mẫu số như nhau. RPC là số attempt đọc trong đường xử lý có telemetry, không phải tổng RPC hệ thống; mẫu số đã gửi và có telemetry đều được giữ. Timeout có thể đã hoàn tất ở server nhưng kết quả client chưa biết.

Thu hồi: hai thiết bị chung license; token cũ giữ nguyên và thiết bị còn lại xin mới rồi truy cập. Mỗi seed chọn offset trong chu kỳ poll cố định 10 s, dùng lại giữa cấu hình. Credential được cấp ngay trước lịch thu hồi và kiểm tra cả hai đang được phép. Event được nhận hoặc cố ý bỏ; event check và probe mục tiêu 100 ms, nhịp thực tế trong raw/CSV. Quan sát 13 s sau xác nhận receipt canonical. Mốc phát hiện có thể sớm hơn xác nhận client vì event consumer độc lập; giá trị âm được giữ. 'no_allow_observed' không có nghĩa cận thật bằng 0; 'right_censored' là còn allow cuối cửa sổ; lỗi kỹ thuật giữ riêng. Một lần thu hồi là một đơn vị lặp, không phải mỗi probe. HTTP và thu hồi chạy riêng: KHÔNG kết luận thu hồi dưới tải HTTP 100 thao tác/s.

## Tệp và tái tạo

raw/: input-config, run-manifest, NDJSON và log từng attempt. tables/http-runs.csv và revocation-runs.csv giữ từng lượt (thu hồi có hai hàng cohort trên cùng run). http-summary và revocation-summary: trung vị/min/max, số quan sát có dữ liệu; paper-table.csv ghép cùng cache/token, tách event/cohort. paired-seeds.csv: chênh lệch theo seed. token-timestamps.csv: mốc đọc/ký/D/kiểm tra và phân loại hết hạn; thiếu bằng chứng để 'undetermined'. attempt-inventory.csv giữ lỗi/retry. figures/http-throughput.svg tái tạo từ dữ liệu thật.

Sau giải nén, không cần dịch vụ mạng hay Python package ngoài:

```
python scripts/analyze-e01.py .
```

Chạy lại phép đo từ repo đúng commit, áp dụng patch và chép các script mới về tooling/emukey/research, cài dependency theo lockfile. Dịch vụ local theo README repo, RESEARCH_DECISION_TRACE=1. Chỉ chain 31337, không xóa volume. Lệnh bắt đầu/tiếp tục:

```
powershell -NoProfile -ExecutionPolicy Bypass -File tooling/emukey/research/Run-E01.ps1 -Directory "EmuKey/backend/.research-local/evidence/EmuKey_E01_20261113"
```

Xem tiến độ: cùng lệnh thêm -Status. Runner chạy nền độc lập phiên chat, ghi manifest sau từng lượt; bỏ qua lượt đã VALID sau kiểm tra lại, giữ attempt trước và retryOf. Khi bị ngắt, dùng lại đúng Directory và mã nguồn. Máy ngủ hoặc dịch vụ lỗi cần kiểm tra log; không coi dữ liệu thiếu là đã hoàn thành.

## Giới hạn

Một máy Windows, Hardhat local 31337, PostgreSQL/Redis Docker, API/worker trên host; không cách ly toàn máy hoặc suy rộng ra mainnet. Seed ghép lịch tải, không loại được trôi hiệu năng theo thời gian. Năm sự kiện mỗi tình huống chưa đủ xác lập cận độ trễ bảo đảm. Cực đại quan sát không phải cận lý thuyết. Không chọn cấu hình tối ưu phổ quát. Cấu hình tăng thông lượng có thể đánh đổi cửa sổ quyền cũ; đọc các chênh lệch cùng seed và bảng thu hồi tương ứng.

checksums.sha256 bao phủ mọi tệp đóng gói trừ chính nó. Tệp verification.json bên cạnh ZIP xác nhận CRC, SHA256 và tái tạo bảng/biểu đồ từ ZIP đã giải nén. Không chứa token, khóa riêng hoặc mật khẩu.
'''.format(commit=m['commit'])
(root/'README.md').write_text(readme,encoding='utf-8')
allowed=[]
for p in sorted(root.rglob('*')):
 if not p.is_file() or p.name in ['runner.lock','checksums.sha256'] or p.suffix=='.tmp' or p.name.startswith('supervisor-'):continue
 rel=p.relative_to(root).as_posix()
 if rel.startswith(('raw/','scripts/','tables/','figures/','checks/')) or rel in ['README.md','KET_QUA_E01.md','manifest.json','analysis-validation.json','preflight.json']:allowed.append(p)
# Inspect evidence, not source literals documenting secret handling.
for p in allowed:
 if p.suffix in ['.json','.ndjson','.log','.csv','.md'] and 'scripts' not in p.relative_to(root).parts:
  text=p.read_text(encoding='utf-8',errors='replace')
  if re.search(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',text) or re.search(r'"(?:privateKey|password|token)"\s*:\s*"[^"\s]+"',text):raise RuntimeError('Possible secret in '+str(p))
(root/'checksums.sha256').write_text(''.join(sha(p)+'  '+p.relative_to(root).as_posix()+'\n' for p in allowed),encoding='utf-8');allowed.append(root/'checksums.sha256')
dest=repo/'EmuKey_E01_20261113.zip'
if dest.exists():raise RuntimeError('Refusing to overwrite existing ZIP')
pending=dest.with_name(dest.stem+'.partial-'+datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%S%f')+'.zip')
with zipfile.ZipFile(pending,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for p in allowed:z.write(p,p.relative_to(root).as_posix())
with tempfile.TemporaryDirectory(prefix='emukey-e01-') as tmp:
 extracted=pathlib.Path(tmp)
 with zipfile.ZipFile(pending) as z:
  if z.testzip():raise RuntimeError('ZIP CRC failure')
  z.extractall(extracted)
 for line in (extracted/'checksums.sha256').read_text().splitlines():
  h,name=line.split('  ',1)
  if sha(extracted/name)!=h:raise RuntimeError('Checksum mismatch: '+name)
 before={p.relative_to(extracted).as_posix():sha(p) for folder in ['tables','figures'] for p in (extracted/folder).glob('*')}
 before['KET_QUA_E01.md']=sha(extracted/'KET_QUA_E01.md')
 subprocess.run([sys.executable,str(extracted/'scripts/analyze-e01.py'),str(extracted)],check=True)
 if any(sha(extracted/p)!=h for p,h in before.items()):raise RuntimeError('Offline reproduction differs')
 pending.rename(dest)
 verified={'zip':str(dest),'sha256':sha(dest),'crc':True,'checksums':True,'offlineReproduction':True,'counts':validation['counts'],'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 dest.with_suffix('.verification.json').write_text(json.dumps(verified,indent=2),encoding='utf-8');print(json.dumps(verified))
