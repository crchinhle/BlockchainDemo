import { researchOpenApi } from '../../modules/research/openapi.js';
import { renderArtifact } from '../../modules/research/artifact-renderer.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  Patch,
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  Res,
  Module,
  HttpException,
} from '@nestjs/common';
import { SwaggerModule, DocumentBuilder, ApiBody } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Queue, Worker } from 'bullmq';
import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
  scryptSync,
} from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  db,
  redis,
  initialize,
  json,
  digest,
} from '../../modules/research/infrastructure.js';
import {
  validateConfig,
  csv,
  summarize,
  type Config,
} from '../../modules/research/domain.js';
import {
  dataset,
  freezeArtifact,
} from '../../modules/research/runner.js';

import { ChainV2 } from '../../modules/research/protocol-v2.js';
import { HttpBenchmark, type BenchmarkConfig } from '../../modules/research/http-benchmark.js';
import type { Address, Hex } from 'viem';
const httpBenchmark=new HttpBenchmark();
import { runExperimentV2, reconcileV2 } from '../../modules/research/runner-v2.js';
const chain = new ChainV2();
const connection = {
  host: process.env.RESEARCH_REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.RESEARCH_REDIS_PORT ?? 56379),
};
const queue = new Queue('research-runs', { connection });
type User = { username: string; role: string };
let passwordHash: Buffer;
function fail(code: number, message: string): never {
  throw new HttpException({ message }, code);
}
async function actor(req: Request): Promise<User> {
  const token = req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('research_session='))
    ?.slice(17);
  if (!token) fail(401, 'Đăng nhập trước khi sử dụng');
  const data = await redis.get(`research:session:${digest(token)}`);
  if (!data) fail(401, 'Phiên hết hạn');
  const user = JSON.parse(data) as User;
  if (user.role !== 'researcher') fail(403, 'Cần quyền researcher');
  return user;
}
async function own(req: Request, id: string) {
  const user = await actor(req);
  if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'ID không hợp lệ');
  const r = await db.query(
    'SELECT * FROM research.runs WHERE id=$1 AND owner=$2',
    [id, user.username],
  );
  if (!r.rows[0]) fail(404, 'Không tìm thấy lượt chạy');
  return r.rows[0] as { id: string; state: string; config: Config };
}
async function preflight(central = false) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  for (const [name, fn] of [
    ['PostgreSQL', () => db.query('SELECT 1 FROM research.runs LIMIT 1')],
    ['Redis', () => redis.ping()],
    [
      'EVM chainId / contract',
      async () => {
        if (central) return;
        if (
          (await chain.rpc.getChainId()) !== 31337 ||
          !(await chain.rpc.getCode({ address: chain.address }))
        )
          throw new Error('CHAIN_INVALID');
      },
    ],
    [
      'Signer balance / role',
      async () => {
        if (central) return;
        if ((await chain.rpc.getBalance({ address: chain.signer })) === 0n)
          throw new Error('NO_BALANCE');
        if ((await chain.rpc.readContract({address:chain.address,abi:chain.abi,functionName:'administrator'})) !== chain.signer) throw new Error('NO_ADMIN');
      },
    ],
    [
      'Worker',
      async () => {
        if (!(await redis.exists('research:worker')))
          throw new Error('WORKER_OFFLINE');
      },
    ],
  ] as const) {
    try {
      await fn();
      checks.push({ name, ok: true, detail: 'OK' });
    } catch {
      checks.push({ name, ok: false, detail: 'Không sẵn sàng' });
    }
  }
  return {
    ok: checks.every((c) => c.ok),
    checks,
    environment: 'research-local',
  };
}

@Controller('api/research')
class ResearchController {
  @Post('benchmarks') async benchmarkCreate(@Req() req:Request,@Body() body:BenchmarkConfig){return httpBenchmark.create((await actor(req)).username,body);}
  @Post('benchmarks/:id/fixtures') async benchmarkFixture(@Req() req:Request,@Param('id') id:string,@Body() body:{key:Address}){return httpBenchmark.prepare(id,(await actor(req)).username,body.key);}
  @Post('benchmarks/:id/request') async benchmarkRequest(@Req() req:Request,@Param('id') id:string,@Body() body:{index:number;operation:string;nonce?:string;signature?:Hex;token?:string}){return httpBenchmark.request(id,(await actor(req)).username,body);}
  @Post('benchmarks/:id/revoke') async benchmarkRevoke(@Req() req:Request,@Param('id') id:string,@Body() body:{index:number}){return httpBenchmark.revoke(id,(await actor(req)).username,body.index);}
  @Post('benchmarks/:id/finish') async benchmarkFinish(@Req() req:Request,@Param('id') id:string){return httpBenchmark.finish(id,(await actor(req)).username);}
  @Get('benchmark-metrics') async benchmarkMetrics(@Req() req:Request){await actor(req);return httpBenchmark.metrics();}
  @Post('login') async login(
    @Body() body: { username?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = `research:login:${req.ip}`;
    if ((await redis.incr(key)) > 20) fail(429, 'Thử lại sau');
    await redis.expire(key, 60);
    const supplied = scryptSync(
      typeof body.password === 'string' ? body.password : '',
      'research-local-auth-v1',
      32,
    );
    if (
      body.username !== 'researcher' ||
      !timingSafeEqual(supplied, passwordHash)
    )
      fail(401, 'Sai thông tin đăng nhập');
    const token = randomBytes(32).toString('hex');
    await redis.set(
      `research:session:${digest(token)}`,
      json({ username: 'researcher', role: 'researcher' }),
      'EX',
      28800,
    );
    res.cookie('research_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 28800000,
    });
    return { username: 'researcher', role: 'researcher' };
  }
  @Get('me') me(@Req() req: Request) {
    return actor(req);
  }
  @Post('logout') async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await actor(req);
    const token = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('research_session='))
      ?.slice(17);
    if (token) await redis.del(`research:session:${digest(token)}`);
    res.clearCookie('research_session');
    return { ok: true };
  }
  @Get('preflight') async health(@Req() req: Request) {
    await actor(req);
    return preflight();
  }
  @Get('runs') async list(@Req() req: Request) {
    const user = await actor(req);
    return (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM research.runs WHERE owner=$1 AND state <> 'TEST_FIXTURE' ORDER BY created_at DESC LIMIT 100",
        [user.username],
      )
    ).rows;
  }
  @Post('runs')
  @ApiBody({ schema: { type: 'object', additionalProperties: true } })
  async create(@Req() req: Request, @Body() body: Partial<Config>) {
    const user = await actor(req);
    let config;
    try {
      config = validateConfig(body);
    } catch (e) {
      fail(400, (e as Error).message);
    }
    const id = randomUUID();
    return (
      await db.query(
        'INSERT INTO research.runs(id,owner,name,config) VALUES($1,$2,$3,$4) RETURNING *',
        [id, user.username, config.name, json(config)],
      )
    ).rows[0] as unknown;
  }
  @Patch('runs/:id') async configure(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Partial<Config>,
  ) {
    const run = await own(req, id);
    if (run.state !== 'DRAFT') fail(409, 'C?u h?nh ?? kh?a');
    let config: Config;
    try {
      config = validateConfig({ ...run.config, ...body });
    } catch (e) {
      fail(400, (e as Error).message);
    }
    const updated = await db.query<Record<string, unknown>>(
      "UPDATE research.runs SET config=$2,name=$3 WHERE id=$1 AND state='DRAFT' RETURNING *",
      [id, json(config), config.name],
    );
    if (!updated.rows[0]) fail(409, 'C?u h?nh ?? kh?a');
    return updated.rows[0];
  }
  @Get('runs/:id/samples') async samples(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('offset') offset = '0',
    @Query('limit') limit = '100',
    @Query('decision') decision = '',
    @Query('reason') reason = '',
  ) {
    await own(req, id);
    return (
      await db.query<{
        id: string;
        repetition_id: string;
        data: Record<string, unknown>;
      }>(
        "SELECT id,repetition_id,data FROM research.samples WHERE run_id=$1 AND ($4='' OR data->>'decision'=$4) AND ($5='' OR data->>'reason'=$5) ORDER BY id OFFSET $2 LIMIT $3",
        [
          id,
          Math.max(0, Number(offset) || 0),
          Math.min(500, Math.max(1, Number(limit) || 100)),
          decision,
          reason,
        ],
      )
    ).rows.map((r) => ({
      ...r.data,
      id: r.id,
      repetition_id: r.repetition_id,
    }));
  }
  @Post('runs/:id/start') async start(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    const selected = await own(req, id);
    if (!(await preflight(selected.config.strategy === 'CENTRALIZED')).ok) fail(503, 'Môi trường chưa sẵn sàng');
    const r = await db.query(
      "UPDATE research.runs SET state='QUEUED' WHERE id=$1 AND state='DRAFT' RETURNING id",
      [id],
    );
    if (!r.rowCount) fail(409, 'Cấu hình đã khóa');
    await queue.add('run', { id }, { jobId: id, attempts: 1 });
    return { id, state: 'QUEUED' };
  }
  @Post('runs/:id/cancel') async cancel(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    await own(req, id);
    await db.query(
      "UPDATE research.runs SET cancel_requested=true,state=CASE WHEN state IN ('DRAFT','QUEUED') THEN 'CANCELLED' ELSE state END WHERE id=$1 AND state NOT IN ('COMPLETED','FAILED','CANCELLED','INTERRUPTED')",
      [id],
    );
    return { requested: true };
  }
  @Post('runs/:id/retry') async retry(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    const run = await own(req, id);
    return this.create(req, {
      ...run.config,
      name: run.config.name + ' · chạy lại',
    });
  }
  @Get('runs/:id') async result(@Req() req: Request, @Param('id') id: string) {
    await own(req, id);
    const data = await dataset(id);
    const config = data.run.config as Config;
    return {
      ...data,
      summary: {
        ...summarize(data.samples, null, Date.now(), 1000 / config.rate),
        staleAccepts: data.samples.filter((s) => s.stale).length,
        repetitions: data.repetitions.map((r) => r.summary),
      },
    };
  }
  @Get('runs/:id/events') async events(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('offset') offset = '0',
    @Query('limit') limit = '100',
  ) {
    await own(req, id);
    return (
      await db.query<Record<string, unknown>>(
        'SELECT * FROM research.events WHERE run_id=$1 ORDER BY id OFFSET $2 LIMIT $3',
        [
          id,
          Math.max(0, Number(offset) || 0),
          Math.min(500, Math.max(1, Number(limit) || 100)),
        ],
      )
    ).rows;
  }
  @Get('runs/:id/export') async export(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('format') format: string,
    @Res() res: Response,
  ) {
    const run = await own(req, id);
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(run.state))
      await freezeArtifact(id);
    const artifact = await db.query<{
      data: Awaited<ReturnType<typeof dataset>>;
      checksum: string;
    }>('SELECT * FROM research.artifacts WHERE run_id=$1', [id]);
    if (!artifact.rows[0])
      fail(409, 'Báo cáo chỉ đóng băng khi lượt chạy kết thúc');
    const { data, checksum } = artifact.rows[0];
    const envelope = {
      ...data,
      dataHash: checksum,
      createdAt: String(
        (
          await db.query<{ created_at: Date }>(
            'SELECT created_at FROM research.artifacts WHERE run_id=$1',
            [id],
          )
        ).rows[0]!.created_at.toISOString(),
      ),
    };
    if (format === 'pdf' || format === 'png') {
      res.setHeader(
        'Content-Type',
        format === 'pdf' ? 'application/pdf' : 'image/png',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${id}.${format}"`,
      );
      res.send(await renderArtifact(envelope, format));
      return;
    }
    let out: string;
    let mime = 'text/plain; charset=utf-8';
    if (format === 'json') {
      out = json(envelope);
      mime = 'application/json';
    } else if (format === 'samples.csv') {
      out = csv(data.samples, Object.keys(data.samples[0] ?? {}));
      mime = 'text/csv; charset=utf-8';
    } else if (format === 'events.csv') {
      out = csv(
        data.events.map((e) => ({ ...e, data: json(e.data) })),
        ['id', 'repetition_id', 'kind', 'at', 'data'],
      );
      mime = 'text/csv; charset=utf-8';
    } else if (format === 'summary.csv') {
      out = csv(
        data.repetitions.map((r) => ({
          id: r.id,
          state: r.state,
          ...(r.summary as object),
        })),
        [
          'id',
          'state',
          'sampleCount',
          'staleAccepts',
          'observedWindowMs',
          'p50Ms',
          'p95Ms',
          'p99Ms',
          'rightCensored',
        ],
      );
      mime = 'text/csv; charset=utf-8';
    } else if (format === 'md') {
      out = `# EmuKey Research Lab\n\nRun: ${id}\n\nData SHA256: ${checksum}\n\nPhương pháp: ${json(data.run.config)}\n\n${data.repetitions.map((r) => `Repetition ${String(r.ordinal)}: ${json(r.summary)}`).join('\n\n')}\n\nChỉ báo cáo các probe đã quan sát. Smoke không thay thế repetitions nghiên cứu. CPU/RAM N/A.\n`;
    } else if (format === 'svg') {
      mime = 'image/svg+xml';
      const points = data.samples
        .map(
          (s, i) =>
            `${40 + (i * 720) / Math.max(1, data.samples.length - 1)},${s.decision === 'ALLOW' ? 60 : 160}`,
        )
        .join(' ');
      out = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="240"><rect width="800" height="240" fill="white"/><text x="20" y="24">Run ${id}</text><text x="5" y="60">ALLOW</text><text x="5" y="160">DENY</text><polyline points="${points}" fill="none" stroke="#1e40af"/><text x="20" y="220">Sequence · ${data.samples.length} samples · ${checksum.slice(0, 16)}</text></svg>`;
    } else
      fail(
        400,
        'Định dạng hỗ trợ: json, samples.csv, events.csv, summary.csv, md, svg',
      );
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${id}.${format}"`,
    );
    res.send(out);
  }
  @Post('compare') async compare(
    @Req() req: Request,
    @Body() body: { ids: string[] },
  ) {
    if (!Array.isArray(body.ids) || body.ids.length < 2 || body.ids.length > 10)
      fail(400, 'Chọn 2–10 run');
    const runs = [];
    for (const id of body.ids) {
      await own(req, id);
      runs.push(await dataset(id));
    }
    const signatures = runs.map((r) => {
      const c = r.run.config as Config;
      const manifest = r.run.manifest as Record<string, unknown>;
      return json({
        modelVersion: manifest.modelVersion ?? 1,
        measurementBoundary: manifest.measurementBoundary,
        seed: c.seed,
        rate: c.rate,
        devices: c.devices,
        licenses: c.licenses,
        clients: c.clients,
        concurrency: c.concurrency,
        observeMs: c.observeMs,
        network: manifest.modelVersion === 2 ? 'research-local-v2' : manifest.network,
        chainInstance: manifest.modelVersion === 2 ? undefined : manifest.chainInstance,
        codeHash: (r.run.manifest as Record<string, unknown>).codeHash,
        warmupMs: c.warmupMs,
        revokeAfterMs: c.revokeAfterMs,
        confirmations: c.confirmations,
        fault: c.fault,
        faultDurationMs: c.faultDurationMs,
      });
    });
    const compatible =
      signatures.every((s) => s === signatures[0]) &&
      new Set(runs.map(r=>(r.run.manifest as Record<string,unknown>).chainInstance).filter(Boolean)).size <= 1 &&
      runs.every(
        (r) =>
          (Boolean((r.run.manifest as Record<string, unknown>).chainInstance) || (r.run.manifest as Record<string, unknown>).modelVersion === 2) &&
          r.run.state === 'COMPLETED',
      );
    return {
      compatible,
      reasons: compatible
        ? []
        : ['Khác workload hoặc môi trường; không so sánh trực tiếp.'],
      runs,
    };
  }
}
@Module({ controllers: [ResearchController] })
class ResearchModule {}
await initialize();
if (process.argv.includes('--setup')) {
  await chain.init(true);
  await mkdir('.research-local', { recursive: true });
  const password = randomBytes(18).toString('base64url');
  await writeFile(
    '.research-local/login.json',
    json({ username: 'researcher', password }),
    { flag: 'wx' },
  ).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
  });
  console.log(
    'Research schema/contract ready. Local login: backend/.research-local/login.json',
  );
  await db.end();
  redis.disconnect();
  await queue.close();
} else if (process.argv.includes('--worker')) {
  const lease = await db.connect();
  const held = await lease.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(31337001) AS locked',
  );
  if (!held.rows[0]?.locked) throw new Error('RESEARCH_WORKER_ALREADY_RUNNING');
  lease.on('error', () => process.exit(1));
  await chain.init().catch(() => undefined); // Centralized remains available without EVM.
  await reconcileV2(chain);
  const interrupted = await db.query<{ id: string }>(
    "UPDATE research.runs SET state='INTERRUPTED',error='Worker restarted; timeline invalid for analysis' WHERE state IN ('PREPARING','WARMING','RUNNING','REVOKING','OBSERVING') RETURNING id",
  );
  for (const r of interrupted.rows) {
    await db.query(
      "UPDATE research.repetitions SET state='INTERRUPTED' WHERE run_id=$1 AND state NOT IN ('COMPLETED','CANCELLED','FAILED')",
      [r.id],
    );
    await freezeArtifact(r.id);
  }
  const worker = new Worker(
    'research-runs',
    async (job) => {
      await runExperimentV2((job.data as { id: string }).id, chain);
    },
    { connection, concurrency: 1, maxStalledCount: 0 },
  );
  worker.on('error', () => console.error('research.worker.error'));
  setInterval(() => {
    void redis.set('research:worker', String(Date.now()), 'PX', 5000);
    void db
      .query<{ id: string }>(
        "SELECT id FROM research.runs WHERE state='QUEUED'",
      )
      .then(async (r) => {
        for (const row of r.rows)
          await queue.add(
            'run',
            { id: row.id },
            { jobId: row.id, attempts: 1 },
          );
      });
    void reconcileV2(chain);
  }, 1000);
  console.log('Research worker ready');
} else {
  await db.query("UPDATE research.http_benchmarks SET state='INTERRUPTED' WHERE state='PREPARING'");
  await chain.init().catch(() => undefined); // Centralized remains available without EVM.
  const credential = JSON.parse(
    await readFile('.research-local/login.json', 'utf8'),
  ) as { password: string };
  passwordHash = scryptSync(credential.password, 'research-local-auth-v1', 32);
  const app = await NestFactory.create(ResearchModule, {
    logger: ['error', 'warn'],
  });
  app.use((req: Request, res: Response, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      req.method === 'POST' &&
      req.headers.origin &&
      ![
        'http://localhost:5174',
        'http://127.0.0.1:5174',
        'http://127.0.0.1:3100',
      ].includes(req.headers.origin)
    ) {
      res.status(403).json({ message: 'Origin rejected' });
      return;
    }
    next();
  });
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('EmuKey Research Lab')
      .setVersion('1')
      .build(),
  );
  researchOpenApi(doc);
  SwaggerModule.setup('api/research/docs', app, doc);
  await writeFile('.research-local/openapi.json', json(doc));
  await app.listen(3100, '127.0.0.1');
  console.log('Research API http://127.0.0.1:3100');
}
