# EmuKey Research Lab

Bản nghiên cứu local độc lập từ `crchinhle/MCP_API@8357c8c1ca7af68ff36bd5bc87641702d6679f27`. Giao diện tiếng Việt điều khiển worker, phát hành/kích hoạt/thu hồi trên EVM thật, thử token cũ và refresh client; lưu PostgreSQL, xuất CSV/JSON/Markdown/SVG/PNG/PDF. Đọc giới hạn trong [model-alignment](docs/research/model-alignment.md) trước khi dùng kết quả viết bài.

## Cài đặt — Windows / PowerShell

Cần Node **22.21.0**, Corepack/pnpm **11.25.0**, Python 3.11+ và Docker Desktop đang chạy Linux containers. Không cần PostgreSQL cài trực tiếp trên Windows, ví, RPC testnet, dịch vụ email/thanh toán.

Từ thư mục `emukey-research-lab`:

```powershell
corepack pnpm --dir EmuKey/backend install --frozen-lockfile
corepack pnpm --dir EmuKey/frontend install --frozen-lockfile
corepack pnpm --dir EmuKey/backend/contracts build
corepack pnpm --dir EmuKey/backend build
python -m venv EmuKey/backend/.research-local/python
EmuKey/backend/.research-local/python/Scripts/python.exe -m pip install -r EmuKey/backend/scripts/research-requirements.txt
node EmuKey/scripts/research-local.mjs
```

Mở **http://127.0.0.1:5174/research.html**. Lần đầu script tạo tài khoản `researcher`, mật khẩu ngẫu nhiên trong `EmuKey/backend/.research-local/login.json` (đã ignore Git). Đăng nhập → Kiểm tra môi trường → Preset Smoke → Chạy thí nghiệm → Theo dõi → Báo cáo nghiên cứu → tải CSV/JSON/PDF.

Giữ terminal chạy supervisor. Đóng/refresh tab không dừng worker. Ctrl+C dừng các process do supervisor tạo, giữ container và volume dữ liệu. Script từ chối nếu một instance khác đang dùng cổng. Không chạy hai supervisor cùng lúc.

Linux/macOS: cùng các lệnh pnpm; dùng `python3 -m venv ...`, đường dẫn Python venv là `EmuKey/backend/.research-local/python/bin/python`. Cài font DejaVu Sans để PDF/PNG hỗ trợ tiếng Việt (Windows dùng Arial). Có thể đặt `RESEARCH_REPORT_FONT` tới tệp TTF.

## SQL hoàn toàn trong Docker

`EmuKey/compose.research.yml` gồm PostgreSQL 15, Redis 8.2 và container one-shot `database-initialize`. SQL được mount read-only từ `backend/database/research.sql`; `psql --single-transaction --set=ON_ERROR_STOP=1` chạy **trong container**. Backend không tự tạo/migrate schema.

```powershell
docker compose -f EmuKey/compose.research.yml up -d postgres redis
docker compose -f EmuKey/compose.research.yml run --rm database-initialize
docker compose -f EmuKey/compose.research.yml ps -a
docker compose -f EmuKey/compose.research.yml exec -T postgres psql -U research -d emukey_research -c "SELECT id,name,state FROM research.runs ORDER BY created_at DESC LIMIT 10;"
```

Kết nối từ host: `127.0.0.1:55432`, database `emukey_research`, user `research`, mật khẩu local `local-research-only`. Trong mạng Compose: host `postgres`, port `5432`. Chỉ dành môi trường local; không dùng credentials này cho triển khai công khai. Redis host port `56379`. Volume `emukey-research-lab_research-pg` và `emukey-research-lab_research-redis` giữ dữ liệu khi restart. **Không dùng `down -v` nếu cần giữ kết quả.** Initializer hiện idempotent cho schema mới; thay đổi schema tương lai cần migration riêng, không reset dữ liệu.

EVM/API/worker/web hiện chạy process Node trên host, còn SQL/Redis và khởi tạo SQL trong Docker. Không mô tả đây là toàn bộ ứng dụng đã container hóa. Cổng EVM `58545`, API `3100`, web `5174`, tất cả bind loopback. EVM là ephemeral: khởi động lại node tạo chain mới; JSON/receipt lịch sử giữ trong PostgreSQL nhưng không thể truy vấn lại chain cũ. Không so sánh các chain instance như cùng một môi trường.

## Chạy riêng từng thành phần

Sau Docker initializer, từ `EmuKey/backend/contracts`: `corepack pnpm exec hardhat node --hostname 127.0.0.1 --port 58545`. Hardhat trực tiếp in public dev keys; supervisor ở trên loại bỏ output đó.

Trong `EmuKey/backend`, chạy `node dist/entrypoints/research/main.js --setup` một lần, rồi hai terminal: `node dist/entrypoints/research/main.js --worker` và `node dist/entrypoints/research/main.js`.

Trong `EmuKey/frontend`: `corepack pnpm exec vite --config vite.research.config.ts`.

Không có `.env` nguồn được sao chép. Mặc định local đã đủ chạy; biến tùy chọn: `RESEARCH_DATABASE_URL`, `RESEARCH_REDIS_URL`, `RESEARCH_REDIS_HOST`, `RESEARCH_REDIS_PORT`, `RESEARCH_RPC_URL`, `RESEARCH_PYTHON`, `RESEARCH_REPORT_FONT`. Nếu đổi Redis, phải đổi cả URL lẫn host/port queue tương ứng. API từ chối chainId khác 31337.

## Kiểm chứng

Từ root, khi môi trường đang chạy:

```powershell
node --test tests/emukey/research/domain.test.mjs
node tests/emukey/research/http-smoke.mjs
```

Từ `EmuKey/backend`: `node ../../tests/emukey/research/protocol.mjs`.
Từ `EmuKey/frontend`: `node scripts/research-e2e.mjs` (Chromium Playwright cần có; cài bằng `corepack pnpm exec playwright install chromium` nếu thiếu).

Kiểm tra export độc lập từ root:

```powershell
python tooling/emukey/research/verify-export.py <duong-dan-export.json>
corepack pnpm --dir EmuKey/backend typecheck
corepack pnpm --dir EmuKey/backend exec eslint src/modules/research src/entrypoints/research
corepack pnpm --dir EmuKey/frontend typecheck
corepack pnpm --dir EmuKey/frontend exec eslint src/research
corepack pnpm --dir EmuKey/frontend exec vite build --config vite.research.config.ts
```

HTTP test lưu evidence trong ignored `EmuKey/backend/.research-local/evidence`. Chỉ smoke, không coi là 10 repetitions cho kết luận khoa học. Các run lỗi và thử nghiệm trước sửa lỗi vẫn giữ lại. `/api/research/docs` cung cấp OpenAPI; kiểu cấu hình được sinh bằng `node scripts/research-openapi.mjs` trong frontend, các response chưa được sinh kiểu đầy đủ.

## Cấu trúc sau khi tinh gọn

Đã bỏ ứng dụng mobile/demo Android, giao diện thương mại, module thanh toán/email/AI, schema thương mại, CI và tài liệu/tooling cũ không dùng trong Research Lab. Phần backend giữ `research` cùng ba tiện ích gốc về crypto, PostgreSQL và Redis; frontend chỉ giữ `src/research`. Thông tin khảo sát nguồn vẫn nằm trong `docs/research` và `source-manifest.json`.

Giữ `node_modules`, artifact hợp đồng, bản build và `.research-local` để môi trường hiện tại tiếp tục chạy; chúng được Git ignore. PostgreSQL/Redis vẫn dùng volume Docker. Package versions và lockfiles được giữ nguyên để cài lại bằng `--frozen-lockfile`.

Các tệp dư được chuyển ra thư mục tạm bên ngoài dự án để có thể khôi phục. Các lệnh mặc định `pnpm build`, `pnpm lint`, `pnpm dev` (frontend), `pnpm start:api` và `pnpm start:worker` (backend) hiện trỏ vào Research Lab.

## Tài liệu bàn giao

- [Source audit](docs/research/source-audit.md), [model alignment và phần chưa hoàn thành](docs/research/model-alignment.md), [quyết định kỹ thuật](docs/research/decisions.md).
- [Schema nghiên cứu](EmuKey/backend/database/research.sql), [source manifest](source-manifest.json).
- [Kết quả kiểm chứng](docs/research/verification.md).

Giữ nguyên xuất xứ, SPDX và thông báo tác giả nguồn. Chưa xác lập quyền phân phối toàn repo; không có repo GitHub mới, commit/push hoặc xuất bản nào được thực hiện.
