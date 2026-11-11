import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAddress, type Address, type Hex } from 'viem';
import { uuidToBytes16 } from '../../platform/crypto/license-crypto.js';
import { db, json, runtimeCodeHash } from './infrastructure.js';
import {
  ChainV2,
  VerifierV2,
  centralIssue,
  centralMutate,
  centralSnapshot,
  deviceIdentity,
  decisionMetrics,
} from './protocol-v2.js';

type Strategy = ConstructorParameters<typeof VerifierV2>[1];
type Fixture = { license: string; product: string; key: Address };
export type BenchmarkConfig = {
  strategy: Strategy;
  cacheMs: number;
  tokenMs: number;
  licenses: number;
};
type Session = {
  owner: string;
  config: BenchmarkConfig;
  verifier: VerifierV2;
  fixtures: Fixture[];
  busy: boolean;
  active: boolean;
};
export class HttpBenchmark {
  private creating = false;
  readonly sessions = new Map<string, Session>();
  readonly chain = new ChainV2();
  private async transact(
    session: string,
    actor: Address,
    operation: string,
    args: unknown[],
  ) {
    const commandId = randomUUID();
    await db.query(
      'INSERT INTO research.http_benchmark_events(session_id,kind,data) VALUES($1,$2,$3)',
      [
        session,
        'transaction_intent',
        json({ commandId, actor, operation, args }),
      ],
    );
    const receipt = await this.chain.send(actor, operation, args);
    if (
      (await this.chain.rpc.getBlock({ blockNumber: receipt.blockNumber }))
        .hash !== receipt.blockHash
    )
      throw new Error('REORG_RECEIPT');
    const confirmedAt=Date.now();
    await db.query(
      'INSERT INTO research.http_benchmark_events(session_id,kind,data) VALUES($1,$2,$3)',
      [session, 'transaction_receipt', json({ commandId, operation, receipt,confirmedAt })],
    );
    return {...receipt,confirmedAt};
  }
  async create(owner: string, config: BenchmarkConfig) {
    if (
      !config ||
      ![
        'CENTRALIZED',
        'CENTRALIZED_CACHE',
        'DIRECT_ONCHAIN',
        'HYBRID',
      ].includes(config.strategy)
    )
      throw new Error('INVALID_STRATEGY');
    for (const [value, min, max] of [
      [config.cacheMs, 100, 120000],
      [config.tokenMs, 100, 120000],
      [config.licenses, 1, 100000],
    ])
      if (!Number.isInteger(value) || value! < min! || value! > max!)
        throw new Error('INVALID_CONFIG');
    if (this.creating || [...this.sessions.values()].some((s) => s.active))
      throw new Error('BENCHMARK_ALREADY_ACTIVE');
    this.creating = true;
    try {
      const central = config.strategy.startsWith('CENTRALIZED');
      if (!central) await this.chain.init();
      const id = randomUUID();
      const manifest = {
        modelVersion: 2,
        boundary:
          'HTTP challenge + client signing + token issue + protected decision',
        config,
        codeHash: await runtimeCodeHash(),
        appCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
        ...(central
          ? { network: 'postgres-local' }
          : await this.chain.fingerprint()),
        serverPid: process.pid,
        node: process.version,
        deltaBoundMs: null,
        epsilonBoundMs: null,
      };
      await db.query(
        "INSERT INTO research.http_benchmarks(id,owner,state,manifest) VALUES($1,$2,'PREPARING',$3)",
        [id, owner, json(manifest)],
      );
      this.sessions.set(id, {
        owner,
        config,
        verifier: new VerifierV2(
          this.chain,
          config.strategy,
          'http:' + id,
          config.cacheMs,
          config.tokenMs,
        ),
        fixtures: [],
        busy: false,
        active: true,
      });
      return { id, manifest };
    } finally {
      this.creating = false;
    }
  }
  session(id: string, owner: string) {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner || !s.active)
      throw new Error('SESSION_UNAVAILABLE');
    return s;
  }
  async prepare(id: string, owner: string, key: Address) {
    const s = this.session(id, owner);
    if (!isAddress(key) || s.busy || s.fixtures.length >= s.config.licenses)
      throw new Error('INVALID_FIXTURE');
    s.busy = true;
    const fixture = { license: randomUUID(), product: randomUUID(), key };
    await db.query(
      'INSERT INTO research.http_benchmark_events(session_id,kind,data) VALUES($1,$2,$3)',
      [id, 'fixture_intent', json(fixture)],
    );
    try {
      const central = s.config.strategy.startsWith('CENTRALIZED');
      const issuer: Address = central
          ? '0x0000000000000000000000000000000000000001'
          : this.chain.signer,
        holder: Address = central
          ? '0x0000000000000000000000000000000000000002'
          : this.chain.owner;
      const expiry = Math.floor(Date.now() / 1000) + 86400;
      const device = deviceIdentity(fixture.license, key);
      if (central) {
        await db.query('INSERT INTO research.v2_products VALUES($1,$2)', [
          fixture.product,
          issuer,
        ]);
        await centralIssue(
          fixture.license,
          fixture.product,
          issuer,
          holder,
          expiry * 1000,
          1,
        );
        await centralMutate(
          fixture.license,
          holder,
          'activate',
          device,
          randomUUID(),
          1,
        );
      } else {
        await this.transact(id, issuer, 'registerProduct', [
          uuidToBytes16(fixture.product),
          issuer,
        ]);
        await this.transact(id, issuer, 'issue', [
          uuidToBytes16(fixture.license),
          uuidToBytes16(fixture.product),
          holder,
          BigInt(expiry),
          1,
          true,
        ]);
        await this.transact(id, holder, 'activate', [
          uuidToBytes16(fixture.license),
          device,
          1n,
          '0x' + randomUUID().replaceAll('-', '').padEnd(64, '0'),
        ]);
      }
      s.fixtures.push(fixture);
      await db.query(
        'INSERT INTO research.http_benchmark_events(session_id,kind,data) VALUES($1,$2,$3)',
        [id, 'fixture_ready', json(fixture)],
      );
      return fixture;
    } finally {
      s.busy = false;
    }
  }
  async request(
    id: string,
    owner: string,
    body: {
      index: number;
      operation: string;
      nonce?: string;
      signature?: Hex;
      token?: string;
    },
  ) {
    const s = this.session(id, owner),
      f = s.fixtures[body.index];
    if (!f) throw new Error('FIXTURE_NOT_FOUND');
    if (body.operation === 'challenge')
      return s.verifier.challenge(f.license, f.product, f.key);
    if (
      typeof body.nonce !== 'string' ||
      typeof body.signature !== 'string' ||
      !/^0x[0-9a-fA-F]{130}$/.test(body.signature)
    )
      throw new Error('INVALID_PROOF');
    const metrics = { rpcCalls: 0, cacheHits: 0 };
    return decisionMetrics.run(metrics, async () => {
      try {
        if (body.operation === 'issue') {
          const r = await s.verifier.issue(
            f.license,
            f.product,
            f.key,
            body.nonce!,
            body.signature!,
          );
          return {
            decision: 'ALLOW',
            token: r.token,
            deadline: r.deadline,
            metrics,
          };
        }
        if (body.operation !== 'verify' || typeof body.token !== 'string')
          throw new Error('INVALID_OPERATION');
        const snapshot = await s.verifier.verify(
          f.license,
          f.product,
          f.key,
          body.token,
          body.nonce!,
          body.signature!,
        );
        return {
          decision: 'ALLOW',
          version: snapshot.version,
          generation: snapshot.generation,
          metrics,
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'UNKNOWN';
        return {
          decision:
            /TOKEN_|LICENSE_|PRODUCT_|PROOF_|REPLAY|JWT|signature|exp.*claim/i.test(
              reason,
            )
              ? 'DENY'
              : 'ERROR',
          reason,
          metrics,
        };
      }
    });
  }
  async revoke(id: string, owner: string, index: number) {
    const s = this.session(id, owner),
      f = s.fixtures[index];
    if (!f || s.busy) throw new Error('INVALID_FIXTURE');
    s.busy = true;
    const submittedAt = Date.now();
    try {
      let receipt: Awaited<ReturnType<HttpBenchmark['transact']>> | null = null;
      if (s.config.strategy.startsWith('CENTRALIZED'))
        await centralMutate(
          f.license,
          '0x0000000000000000000000000000000000000001',
          'revoke',
          '',
        );
      else
        receipt = await this.transact(id, this.chain.signer, 'revoke', [
          uuidToBytes16(f.license),
        ]);
      const referenceAt = receipt?.confirmedAt ?? Date.now();
      const snapshot = s.config.strategy.startsWith('CENTRALIZED')
        ? await centralSnapshot(f.license, deviceIdentity(f.license, f.key))
        : await this.chain.read(f.license, deviceIdentity(f.license, f.key));
      await s.verifier.invalidate(f.license, snapshot);
      const result = {
        submittedAt,
        referenceAt,
        reference: s.config.strategy.startsWith('CENTRALIZED')
          ? 'database-commit-ack'
          : 'receipt-confirmation-1',
        receipt,
      };
      await db.query(
        'INSERT INTO research.http_benchmark_events(session_id,kind,data) VALUES($1,$2,$3)',
        [id, 'revoke', json(result)],
      );
      return JSON.parse(json(result)) as unknown;
    } finally {
      s.busy = false;
    }
  }
  async finish(id: string, owner: string) {
    const s = this.session(id, owner);
    s.active = false;
    this.sessions.delete(id);
    await db.query(
      "UPDATE research.http_benchmarks SET state='CLOSED' WHERE id=$1",
      [id],
    );
    return { closed: true };
  }
  metrics() {
    return {
      at: Date.now(),
      pid: process.pid,
      cpu: process.cpuUsage(),
      memory: process.memoryUsage(),
      scope: 'API process only; excludes EVM/PostgreSQL/Redis',
    };
  }
}
