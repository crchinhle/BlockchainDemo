import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { recoverMessageAddress, type Hex } from 'viem';
import {
  db,
  redis,
  json,
  sleep,
  ResearchChain,
  event,
} from './infrastructure.js';
import { tokenDeadline, type Config } from './domain.js';
type Snapshot = Awaited<ReturnType<ResearchChain['snapshot']>>;
export class PolicyDenied extends Error {
  constructor(
    readonly evidence: {
      snapshot: Snapshot;
      source: string;
      cacheHit: boolean;
      rpcCalls: number;
    },
  ) {
    super('LICENSE_REVOKED');
  }
}
export class ResearchVerificationStrategy {
  readonly secret = randomBytes(32);
  faultUntil = 0;
  constructor(
    readonly chain: ResearchChain,
    readonly config: Config,
    readonly run: string,
    readonly rep: string,
  ) {}
  key(id: string) {
    return `research:31337:${this.chain.address}:${this.run}:${id}:${this.config.variant}:${this.config.cacheTtlMs}:${this.config.freshnessMs}`;
  }
  async challenge(license: string, device: string, purpose: string) {
    const nonce = randomBytes(24).toString('hex');
    const message = `research:v1:${this.run}:${license}:${device}:${purpose}:${nonce}`;
    await redis.set(`research:proof:${nonce}`, message, 'PX', 10000, 'NX');
    return { nonce, message };
  }
  async proof(
    license: string,
    device: string,
    purpose: string,
    nonce: string,
    signature: Hex,
    address: string,
  ) {
    const message = await redis.get(`research:proof:${nonce}`);
    if (
      !message ||
      !message.startsWith(
        `research:v1:${this.run}:${license}:${device}:${purpose}:`,
      )
    )
      throw new Error('REPLAY_OR_BINDING');
    const recovered = await recoverMessageAddress({ message, signature });
    if (recovered.toLowerCase() !== address.toLowerCase())
      throw new Error('INVALID_PROOF');
    const consumed = await redis.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]);return 1;end;return 0",
      1,
      `research:proof:${nonce}`,
      message,
    );
    if (consumed !== 1) throw new Error('REPLAY');
  }
  async activate(
    license: string,
    device: string,
    address: string,
    nonce: string,
    signature: Hex,
  ) {
    await this.proof(license, device, 'activate', nonce, signature, address);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        status: number;
        max_devices: number;
        expires_at: string;
      }>(
        'SELECT * FROM research.licenses WHERE id=$1 AND run_id=$2 FOR UPDATE',
        [license, this.run],
      );
      const l = result.rows[0];
      if (!l || l.status !== 1 || Number(l.expires_at) <= Date.now())
        throw new Error('LICENSE_INACTIVE');
      const existing = await client.query<{ public_key: string }>(
        'SELECT public_key FROM research.devices WHERE license_id=$1 AND id=$2',
        [license, device],
      );
      if (existing.rows.length) {
        if (existing.rows[0]!.public_key !== address)
          throw new Error('DEVICE_PAYLOAD_CONFLICT');
      } else {
        const count = await client.query<{ count: string }>(
          'SELECT count(*) FROM research.devices WHERE license_id=$1',
          [license],
        );
        if (Number(count.rows[0]!.count) >= l.max_devices)
          throw new Error('DEVICE_LIMIT');
        await client.query(
          'INSERT INTO research.devices(license_id,id,public_key) VALUES($1,$2,$3)',
          [license, device, address],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async binding(license: string, device: string) {
    const result = await db.query<{
      public_key: string;
      generation: number;
      product_id: string;
    }>(
      'SELECT d.*,l.product_id FROM research.devices d JOIN research.licenses l ON l.id=d.license_id WHERE d.license_id=$1 AND d.id=$2 AND l.run_id=$3',
      [license, device, this.run],
    );
    if (!result.rows[0]) throw new Error('DEVICE_NOT_BOUND');
    return result.rows[0];
  }
  async invalidate(license: string, snapshot: Snapshot) {
    await redis.eval(
      "redis.call('INCR',KEYS[1]);redis.call('DEL',KEYS[2]);redis.call('SET',KEYS[3],ARGV[1]);return 1",
      3,
      this.key(license) + ':epoch',
      this.key(license),
      this.key(license) + ':revoked',
      String(snapshot.version),
    );
    await event(this.run, this.rep, 'cache_invalidated', {
      licenseId: license,
      blockNumber: snapshot.blockNumber,
      blockHash: snapshot.blockHash,
    });
  }
  async snapshot(license: string): Promise<{
    snapshot: Snapshot;
    source: string;
    cacheHit: boolean;
    rpcCalls: number;
  }> {
    if (this.config.strategy === 'CENTRALIZED') {
      const r = await db.query<{
        status: number;
        expires_at: string;
        version: number;
        generation: number;
        observed_at: string;
        block_number: string;
        block_hash: Hex;
      }>('SELECT * FROM research.licenses WHERE id=$1 AND run_id=$2', [
        license,
        this.run,
      ]);
      const l = r.rows[0];
      if (!l) throw new Error('LICENSE_NOT_FOUND');
      return {
        snapshot: {
          status: l.status,
          expiresAt: Number(l.expires_at),
          version: l.version,
          generation: l.generation,
          observedAt: Date.now(),
          blockNumber: l.block_number,
          blockHash: l.block_hash,
          chainTimestamp: 0,
          rpcCalls: 0,
        },
        source: 'postgres-authority',
        cacheHit: false,
        rpcCalls: 0,
      };
    }
    const key = this.key(license);
    if (
      this.config.strategy === 'HYBRID' &&
      (await redis.exists(key + ':revoked'))
    )
      throw new Error('LICENSE_REVOKED');
    if (this.config.strategy === 'HYBRID') {
      const cached = await redis.get(key);
      if (cached) {
        const s = JSON.parse(cached) as Snapshot;
        if (
          Date.now() <
          s.observedAt +
            Math.min(this.config.cacheTtlMs, this.config.freshnessMs)
        )
          return {
            snapshot: s,
            source: 'redis-snapshot',
            cacheHit: true,
            rpcCalls: 0,
          };
      }
    }
    if (Date.now() < this.faultUntil) throw new Error('RPC_OUTAGE_INJECTED');
    const epoch = (await redis.get(key + ':epoch')) ?? '0';
    const s = await this.chain.snapshot(license);
    if (this.config.fault === 'cache-race')
      await sleep(this.config.faultDurationMs);
    if (this.config.strategy === 'HYBRID') {
      const ttl =
        s.observedAt +
        Math.min(this.config.cacheTtlMs, this.config.freshnessMs) -
        Date.now();
      if (ttl <= 0) throw new Error('SOURCE_STALE');
      const saved = await redis.eval(
        "local e=redis.call('GET',KEYS[1]) or '0';if e~=ARGV[1] or redis.call('EXISTS',KEYS[3])==1 then return 0;end;redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]);return 1",
        3,
        key + ':epoch',
        key,
        key + ':revoked',
        epoch,
        json(s),
        String(ttl),
      );
      if (saved !== 1) throw new Error('CACHE_EPOCH_CHANGED');
    }
    return {
      snapshot: s,
      source: 'rpc-fixed-block + postgres-device',
      cacheHit: false,
      rpcCalls: s.rpcCalls,
    };
  }
  async issue(license: string, device: string, nonce: string, signature: Hex) {
    const bound = await this.binding(license, device);
    await this.proof(
      license,
      device,
      'issue',
      nonce,
      signature,
      bound.public_key,
    );
    const read = await this.snapshot(license);
    const s = read.snapshot;
    const now = Date.now();
    if (s.status !== 1 || s.expiresAt <= now) throw new PolicyDenied(read);
    const expires = tokenDeadline(
      now,
      s.observedAt,
      Math.min(this.config.cacheTtlMs, this.config.freshnessMs),
      this.config.tokenTtlMs,
      s.expiresAt,
    );
    if (expires <= now) throw new Error('SOURCE_STALE');
    const token = await new SignJWT({
      licenseId: license,
      deviceId: device,
      productId: bound.product_id,
      generation: bound.generation,
      version: s.version,
      deadlineMs: expires,
      snapshot: s,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('emukey-research')
      .setAudience('research-protected-resource')
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.ceil(expires / 1000))
      .sign(this.secret);
    return { token, expires, read };
  }
  async verify(
    license: string,
    device: string,
    token: string,
    nonce: string,
    signature: Hex,
  ) {
    const bound = await this.binding(license, device);
    await this.proof(
      license,
      device,
      'verify',
      nonce,
      signature,
      bound.public_key,
    );
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: 'emukey-research',
        audience: 'research-protected-resource',
      }));
    } catch {
      throw new Error('TOKEN_INVALID_OR_EXPIRED');
    }
    if (
      payload.licenseId !== license ||
      payload.deviceId !== device ||
      payload.productId !== bound.product_id ||
      payload.generation !== bound.generation
    )
      throw new Error('TOKEN_BINDING');
    if (
      typeof payload.deadlineMs !== 'number' ||
      payload.deadlineMs <= Date.now()
    )
      throw new Error('TOKEN_EXPIRED');
    let read: {
      snapshot: Snapshot;
      source: string;
      cacheHit: boolean;
      rpcCalls: number;
    };
    if (this.config.strategy === 'HYBRID') {
      if (await redis.exists(this.key(license) + ':revoked'))
        throw new Error('TOKEN_INVALIDATED');
      read = {
        snapshot: payload.snapshot as Snapshot,
        source: 'old-signed-snapshot + postgres-device',
        cacheHit: false,
        rpcCalls: 0,
      };
    } else read = await this.snapshot(license);
    if (
      read.snapshot.status !== 1 ||
      read.snapshot.expiresAt <= Date.now() ||
      read.snapshot.version !== payload.version
    )
      throw new PolicyDenied(read);
    return { ...read, tokenRemainingMs: payload.deadlineMs - Date.now() };
  }
}
