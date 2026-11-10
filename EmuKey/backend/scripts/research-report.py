"""Render only a supplied immutable research dataset. No DB/network access."""
import io,json,sys,os
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image,ImageDraw,ImageFont

sys.stdin.reconfigure(encoding='utf-8')
data=json.load(sys.stdin)
fontpath=next((p for p in [os.environ.get('RESEARCH_REPORT_FONT',''),'C:/Windows/Fonts/arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'] if p and Path(p).exists()),None)
if not fontpath: raise RuntimeError('Install DejaVu Sans or configure RESEARCH_REPORT_FONT')
pdfmetrics.registerFont(TTFont('Research',fontpath))
font=ImageFont.truetype(fontpath,16)
image=Image.new('RGB',(1200,360),'white');draw=ImageDraw.Draw(image)
draw.text((24,16),'EmuKey Research Lab · ALLOW / DENY / ERROR by sample sequence',fill='#15243c',font=font)
draw.text((24,48),'Run '+data['run']['id'],fill='#475569',font=font)
samples=data['samples']
for label,y in [('ALLOW',120),('DENY',210),('ERROR / DROPPED',280)]:
 draw.text((15,y-10),label,fill='#475569',font=font);draw.line((200,y,1170,y),fill='#dbe2ec')
for i,s in enumerate(samples):
 x=205+i*950/max(1,len(samples)-1);y=120 if s['decision']=='ALLOW' else 210 if s['decision']=='DENY' else 280
 color='#d97706' if s.get('stale') else '#13795b' if s['decision']=='ALLOW' else '#1e40af'
 draw.ellipse((x-2,y-2,x+2,y+2),fill=color)
draw.text((24,326),'Data SHA256: '+data['dataHash'],fill='#475569',font=font)
out=io.BytesIO()
if sys.argv[1]=='png':image.save(out,format='PNG')
else:
 c=canvas.Canvas(out,pagesize=A4);w,h=A4;y=h-42
 def line(text,size=10):
  global y
  if y<55:c.showPage();y=h-42
  c.setFont('Research',size)
  # Deterministic word wrapping based on actual font metrics.
  words=str(text).split();row=''
  for word in words:
   if pdfmetrics.stringWidth(row+' '+word,'Research',size)>w-84:
    c.drawString(42,y,row);y-=size+5;row=word
    if y<55:c.showPage();y=h-42;c.setFont('Research',size)
   else:row=(row+' '+word).strip()
  c.drawString(42,y,row);y-=size+6
 line('EmuKey Research Lab',22);line('BÁO CÁO THỰC NGHIỆM LOCAL',12)
 line('Run: '+data['run']['id']);line('Tên: '+data['run']['name']);line('Trạng thái: '+data['run']['state'])
 line('Tạo artifact: '+data['createdAt']);line('Data SHA256: '+data['dataHash'],8)
 line('Formula: '+data['formulaVersion']);line('Môi trường: research-local; EVM chainId 31337; không phải mainnet.')
 c.drawImage(ImageReader(image),42,y-150,width=w-84,height=150);y-=170
 for r in data['repetitions']:
  s=r.get('summary') or {};line('Repetition '+str(r['ordinal'])+' · '+r['state'],12)
  for k in ['sampleCount','allow','deny','error','timeout','dropped','staleAccepts','observedWindowMs','p50Ms','p95Ms','p99Ms','rightCensored','horizonMs','resolutionMs','rpcCalls']:
   value=s.get(k,'N/A')
   if value is None:value='Không quan sát thấy' if k=='observedWindowMs' else 'N/A'
   if isinstance(value,float):value=round(value,3)
   line(k+': '+str(value),9)
 line('Phương pháp và cấu hình',14)
 for k,v in data['run']['config'].items():line(k+': '+json.dumps(v,ensure_ascii=False),9)
 line('Xuất xứ',14)
 for k,v in data['run']['manifest'].items():line(k+': '+str(v),9)
 line('Giới hạn',14)
 line('Smoke chỉ kiểm tra tích hợp. Không quan sát thấy stale acceptance không chứng minh cửa sổ thật bằng 0. Right-censored là quan sát chưa đầy đủ. P99 dưới 100 mẫu không ổn định. CPU/RAM chưa đo. Khóa thiết bị không chứng minh một máy vật lý duy nhất.')
 line('Hash hỗ trợ đối chiếu dataset, không chứng minh chống sửa DB bởi quản trị viên. Không kết luận an toàn tuyệt đối hoặc Hybrid tốt hơn từ latency đơn lẻ.')
 c.save()
sys.stdout.buffer.write(out.getvalue())
