import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, SignJWT, jwtVerify } from 'jose';
import {
  encodeAbiParameters,
  keccak256,
  recoverMessageAddress,
  parseAbiItem,
  isAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { uuidToBytes16 } from '../../platform/crypto/license-crypto.js';
import { ResearchChain, db, redis, json, digest } from './infrastructure.js';
export const decisionMetrics = new AsyncLocalStorage<{
  rpcCalls: number;
  cacheHits: number;
  trace?: Record<string, unknown>;
}>();
// Optional in-memory decision telemetry. Never stores token material or keys.
function trace(values: Record<string, unknown>) {
  const target = decisionMetrics.getStore()?.trace;
  if (target) Object.assign(target, values);
}
function countRpc() {
  const m = decisionMetrics.getStore();
  if (m) m.rpcCalls++;
}

export type LicenseV2 = {
  product: Hex;
  issuer: Address;
  owner: Address;
  expiresAt: bigint;
  maxDevices: number;
  activeDevices: number;
  revoked: boolean;
  transferable: boolean;
  version: bigint;
  generation: bigint;
};
export type SnapshotV2 = {
  product: string;
  issuer: string;
  owner: string;
  expiresAt: number;
  maxDevices: number;
  activeDevices: number;
  revoked: boolean;
  transferable: boolean;
  version: number;
  generation: number;
  active: boolean;
  observedAt: number;
  chainTimestamp?: number;
  blockNumber: string;
  blockHash: string;
  rpcCalls: number;
};
export function deviceIdentity(license: string, key: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'bytes16' }, { type: 'address' }],
      ['emukey-device-v2', uuidToBytes16(license), key],
    ),
  );
}
export class ChainV2 extends ResearchChain {
  owner!: Address;
  constructor(readonly deploymentKey = 'deployment-v2') {
    super();
  }
  override async init(deploy = false) {
    if ((await this.rpc.getChainId()) !== 31337)
      throw new Error('LOCAL_CHAIN_ID_REQUIRED');
    const artifact = JSON.parse(
      await readFile(
        'contracts/artifacts/solidity/ResearchLicenseRegistryV2.sol/ResearchLicenseRegistryV2.json',
        'utf8',
      ),
    ) as { abi: Abi; bytecode: Hex };
    this.abi = artifact.abi;
    this.bytecode = artifact.bytecode;
    const accounts = await this.wallet.getAddresses();
    this.signer = accounts[0]!;
    this.owner = accounts[1]!;
    if (!this.owner) throw new Error('LOCAL_ACTORS_REQUIRED');
    const stored = await db.query<{
      value: { address: Address; codeHash: string };
    }>('SELECT value FROM research.settings WHERE key=$1', [
      this.deploymentKey,
    ]);
    const previous = stored.rows[0]?.value;
    if (previous) {
      const code = await this.rpc.getCode({ address: previous.address });
      if (code && keccak256(code) === previous.codeHash) {
        this.address = previous.address;
        return;
      }
    }
    if (!deploy) throw new Error('DEPLOY_V2_FIRST');
    const hash = await this.wallet.deployContract({
      abi: this.abi,
      bytecode: this.bytecode,
      args: [this.signer, 1000],
      account: this.signer,
      chain: this.wallet.chain,
    });
    const receipt = await this.rpc.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress)
      throw new Error('DEPLOY_FAILED');
    this.address = receipt.contractAddress;
    const value = {
      address: this.address,
      hash,
      codeHash: keccak256((await this.rpc.getCode({ address: this.address }))!),
    };
    await db.query(
      'INSERT INTO research.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [this.deploymentKey, json(value)],
    );
  }
  // Callers supply the actual owner/issuer account. Local unlocked accounts are a lab fixture.
  async send(actor: Address, operation: string, args: unknown[]) {
    if ((await this.rpc.getChainId()) !== 31337)
      throw new Error('LOCAL_CHAIN_ID_REQUIRED');
    const hash = await this.wallet.writeContract({
      address: this.address,
      abi: this.abi,
      functionName: operation,
      args,
      account: actor,
      chain: this.wallet.chain,
    });
    const receipt = await this.rpc.waitForTransactionReceipt({
      hash,
      timeout: 30000,
    });
    if (receipt.status !== 'success')
      throw new Error('TRANSACTION_REVERTED:' + hash);
    return receipt;
  }
  async read(
    license: string,
    device: Hex,
    confirmations = 1,
  ): Promise<SnapshotV2> {
    // Anchor age before any RPC. A late response cannot acquire a new observation time.
    const observedAt = Date.now();
    countRpc();
    const head = await this.rpc.getBlockNumber({ cacheTime: 0 });
    const number = head - BigInt(confirmations - 1);
    if (number < 0n) throw new Error('CONFIRMATIONS_UNAVAILABLE');
    countRpc();
    const block = await this.rpc.getBlock({ blockNumber: number });
    countRpc();
    const [l, active] = (await this.rpc.readContract({
      address: this.address,
      abi: this.abi,
      functionName: 'snapshot',
      args: [uuidToBytes16(license), device],
      blockNumber: number,
    })) as [LicenseV2, boolean];
    countRpc();
    const canonical = await this.rpc.getBlock({ blockNumber: number });
    if (canonical.hash !== block.hash) throw new Error('REORG_SNAPSHOT');
    return {
      ...l,
      expiresAt: Number(l.expiresAt) * 1000,
      version: Number(l.version),
      generation: Number(l.generation),
      active,
      observedAt,
      chainTimestamp: Number(block.timestamp) * 1000,
      blockNumber: String(number),
      blockHash: block.hash,
      rpcCalls: 4,
    };
  }
}

export class VerifierV2 {
  readonly keys = generateKeyPair('ES256');
  constructor(
    readonly chain: ChainV2,
    readonly strategy:
      'CENTRALIZED' | 'CENTRALIZED_CACHE' | 'DIRECT_ONCHAIN' | 'HYBRID',
    readonly domain: string,
    readonly cacheMs = 5000,
    readonly tokenMs = 3000,
    readonly confirmations = 1,
  ) {}
  get cached() {
    return this.strategy === 'HYBRID' || this.strategy === 'CENTRALIZED_CACHE';
  }
  key(id: string) {
    return `research:v2:${this.domain}:31337:${this.chain.address}:${id}`;
  }
  async challenge(license: string, product: string, key: Address) {
    const nonce = randomBytes(24).toString('hex');
    const message = json({
      domain: this.domain,
      chainId: 31337,
      contract: this.chain.address,
      license,
      product,
      key: key.toLowerCase(),
      nonce,
      deadline: Date.now() + 10000,
    });
    await redis.set('research:v2:proof:' + nonce, message, 'PX', 10000, 'NX');
    return { nonce, message };
  }
  async proof(
    license: string,
    product: string,
    key: Address,
    nonce: string,
    signature: Hex,
  ) {
    const cacheKey = 'research:v2:proof:' + nonce;
    const message = await redis.get(cacheKey);
    if (!message) throw new Error('REPLAY_OR_EXPIRED');
    const value = JSON.parse(message) as {
      domain: string;
      chainId: number;
      contract: string;
      license: string;
      product: string;
      key: string;
      deadline: number;
    };
    if (
      value.domain !== this.domain ||
      value.chainId !== 31337 ||
      value.contract !== this.chain.address ||
      value.license !== license ||
      value.product !== product ||
      value.key !== key.toLowerCase() ||
      value.deadline <= Date.now()
    )
      throw new Error('PROOF_BINDING');
    if (
      (await recoverMessageAddress({ message, signature })).toLowerCase() !==
      key.toLowerCase()
    )
      throw new Error('PROOF_INVALID');
    if (
      (await redis.eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]);end;return 0",
        1,
        cacheKey,
        message,
      )) !== 1
    )
      throw new Error('REPLAY');
  }
  async observe(license: string, device: Hex): Promise<SnapshotV2> {
    if (this.strategy === 'CENTRALIZED')
      return centralSnapshot(license, device);
    const key = this.key(license),
      memberKey = key + ':' + device;
    if (this.cached) {
      const cached = await redis.get(memberKey);
      if (cached) {
        const s = JSON.parse(cached) as SnapshotV2;
        const known = Number((await redis.get(key + ':version')) ?? 0);
        if (s.version >= known && Date.now() < s.observedAt + this.cacheMs) {
          const m = decisionMetrics.getStore();
          if (m) m.cacheHits++;
          return { ...s, rpcCalls: 0 };
        }
      }
    }
    const epoch = (await redis.get(key + ':epoch')) ?? '0';
    const s =
      this.strategy === 'CENTRALIZED_CACHE'
        ? await centralSnapshot(license, device)
        : await this.chain.read(license, device, this.confirmations);
    const ttl = s.observedAt + this.cacheMs - Date.now();
    if (ttl <= 0) throw new Error('SOURCE_STALE');
    if (this.cached) {
      const saved = await redis.eval(
        "local e=redis.call('GET',KEYS[1]) or '0';local v=tonumber(redis.call('GET',KEYS[3]) or '0');if e~=ARGV[1] or v>tonumber(ARGV[4]) then return 0;end;local old=redis.call('GET',KEYS[2]);if old then local o=cjson.decode(old);local n=cjson.decode(ARGV[2]);if tonumber(o.blockNumber)>tonumber(n.blockNumber) or o.observedAt>n.observedAt then return 0;end;end;redis.call('SET',KEYS[3],ARGV[4]);redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]);return 1",
        3,
        key + ':epoch',
        memberKey,
        key + ':version',
        epoch,
        json(s),
        String(ttl),
        String(s.version),
      );
      if (saved !== 1) throw new Error('CACHE_EPOCH_CHANGED');
    }
    return s;
  }
  async invalidate(license: string, s: SnapshotV2) {
    // Never regress the observed version; epoch fences every in-flight fill.
    await redis.eval(
      "local old=tonumber(redis.call('GET',KEYS[1]) or '0');if tonumber(ARGV[1])<old then return 0;end;redis.call('SET',KEYS[1],ARGV[1]);redis.call('INCR',KEYS[2]);return 1",
      2,
      this.key(license) + ':version',
      this.key(license) + ':epoch',
      String(s.version),
    );
  }
  async synchronize(
    licenses: string[],
    cursorId: string,
    dropEvents = false,
    eventDelayMs = 0,
  ) {
    if (this.strategy !== 'HYBRID') return;
    const checkpointKey = 'v2-checkpoint:' + this.key(cursorId);
    const saved = await db.query<{ value: { number: string; hash: string } }>(
      'SELECT value FROM research.settings WHERE key=$1',
      [checkpointKey],
    );
    const previous = saved.rows[0]?.value;
    const head =
      (await this.chain.rpc.getBlockNumber({ cacheTime: 0 })) -
      BigInt(this.confirmations - 1);
    if (head < 0n) throw new Error('CONFIRMATIONS_UNAVAILABLE');
    if (previous) {
      const canonical = await this.chain.rpc
        .getBlock({
          blockNumber: BigInt(previous.number),
        })
        .catch(() => null);
      if (!canonical || canonical.hash !== previous.hash) {
        for (const id of licenses)
          await redis.set(this.key(id) + ':unsafe', '1');
        throw new Error('REORG_CHECKPOINT');
      }
    }
    const from = previous ? BigInt(previous.number) + 1n : 0n;
    if (from <= head) {
      const logs = await this.chain.rpc.getLogs({
        address: this.chain.address,
        event: parseAbiItem(
          'event Changed(bytes16 indexed licenseId, uint64 version, uint64 generation, uint8 operation)',
        ),
        fromBlock: from,
        toBlock: head,
      });
      for (const log of logs) {
        const id = licenses.find(
          (id) => uuidToBytes16(id) === log.args.licenseId,
        );
        if (!id || dropEvents) continue;
        if (eventDelayMs) await new Promise((r) => setTimeout(r, eventDelayMs));
        await this.invalidate(id, {
          version: Number(log.args.version),
        } as SnapshotV2);
      }
      const block = await this.chain.rpc.getBlock({ blockNumber: head });
      await db.query(
        'INSERT INTO research.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [checkpointKey, json({ number: String(head), hash: block.hash })],
      );
    }
  }
  allowed(s: SnapshotV2, product: string) {
    trace({ stage: 'license-policy', snapshotObservedAtMs: s.observedAt });
    if (s.product.toLowerCase() !== uuidToBytes16(product).toLowerCase())
      throw new Error('PRODUCT_MISMATCH');
    if (
      s.revoked ||
      s.expiresAt <= Math.max(Date.now(), s.chainTimestamp ?? 0) ||
      !s.active
    )
      throw new Error('LICENSE_INACTIVE');
  }
  async issue(
    license: string,
    product: string,
    key: Address,
    nonce: string,
    signature: Hex,
  ) {
    if (await redis.exists(this.key(license) + ':unsafe'))
      throw new Error('REORG_UNSAFE');
    await this.proof(license, product, key, nonce, signature);
    const device = deviceIdentity(license, key),
      s = await this.observe(license, device);
    this.allowed(s, product);
    const now = Date.now(),
      deadline = Math.min(
        now + this.tokenMs,
        s.observedAt + this.cacheMs,
        s.expiresAt,
      );
    trace({ stage: 'token-issue', snapshotObservedAtMs: s.observedAt, issuanceAnchorAtMs: now, tokenIssuedAtMs: null, tokenDeadlineMs: deadline });
    if (deadline <= now) throw new Error('SOURCE_STALE');
    const token = await new SignJWT({
      license,
      product,
      device,
      key,
      owner: s.owner,
      generation: s.generation,
      version: s.version,
      chainId: 31337,
      contract: this.chain.address,
      deadline,
      snapshot: s,
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(this.domain)
      .setAudience('research-protected-resource-v2')
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.ceil(deadline / 1000))
      .sign((await this.keys).privateKey);
    trace({ tokenIssuedAtMs: Date.now() });
    return { token, snapshot: s, deadline };
  }
  async verify(
    license: string,
    product: string,
    key: Address,
    token: string,
    nonce: string,
    signature: Hex,
  ) {
    if (await redis.exists(this.key(license) + ':unsafe'))
      throw new Error('REORG_UNSAFE');
    await this.proof(license, product, key, nonce, signature);
    trace({ stage: 'jwt-validation', tokenCheckedAtMs: Date.now() });
    const { payload: p } = await jwtVerify(token, (await this.keys).publicKey, {
      algorithms: ['ES256'],
      issuer: this.domain,
      audience: 'research-protected-resource-v2',
    }).catch((error: unknown) => {
      const e = error as { code?: string; claim?: string };
      trace({ jwtErrorCode: e.code ?? null, jwtErrorClaim: e.claim ?? null,
        cause: e.code === 'ERR_JWT_EXPIRED' ? 'TOKEN_EXPIRED' : e.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ? 'SIGNATURE_INVALID' : 'JWT_VALIDATION_FAILED' });
      throw error;
    });
    const device = deviceIdentity(license, key);
    const checkedAt = Date.now();
    const bindingMismatches = [
      ['license', p.license !== license], ['product', p.product !== product],
      ['device', p.device !== device], ['key', p.key !== key],
      ['chainId', p.chainId !== 31337], ['contract', p.contract !== this.chain.address],
      ['deadlineType', typeof p.deadline !== 'number'],
    ].filter((entry) => entry[1]).map((entry) => entry[0]);
    const expired = typeof p.deadline === 'number' && p.deadline <= checkedAt;
    trace({ stage: 'token-binding-and-deadline', tokenCheckedAtMs: checkedAt,
      tokenDeadlineMs: p.deadline, bindingMismatches, expired,
      observedConditions: [...bindingMismatches, ...(expired ? ['deadlineExpired'] : [])] });
    if (
      p.license !== license ||
      p.product !== product ||
      p.device !== device ||
      p.key !== key ||
      p.chainId !== 31337 ||
      p.contract !== this.chain.address ||
      typeof p.deadline !== 'number' ||
      p.deadline <= checkedAt
    )
      { trace({ cause: bindingMismatches.length ? 'BINDING_MISMATCH' : 'TOKEN_EXPIRED' }); throw new Error('TOKEN_BINDING_OR_EXPIRED'); }
    const s = this.cached
      ? { ...(p.snapshot as SnapshotV2), rpcCalls: 0 }
      : await this.observe(license, device);
    this.allowed(s, product);
    const known = Number(
      (await redis.get(this.key(license) + ':version')) ?? 0,
    );
    if (
      p.version !== s.version ||
      p.generation !== s.generation ||
      p.owner !== s.owner ||
      known > Number(p.version)
    )
      { trace({ stage: 'known-version', cause: 'RIGHTS_INVALIDATED' }); throw new Error('TOKEN_INVALIDATED'); }
    trace({ stage: 'accepted', cause: 'ALLOW', decisionAtMs: Date.now() });
    return s;
  }
}

export async function centralSnapshot(
  license: string,
  device: Hex,
): Promise<SnapshotV2> {
  const r = await db.query<{ data: SnapshotV2; active: boolean }>(
    `SELECT l.data,EXISTS(SELECT 1 FROM research.v2_devices d WHERE d.license_id=l.id AND d.generation=(l.data->>'generation')::int AND d.device=$2) active FROM research.v2_licenses l WHERE l.id=$1`,
    [license, device],
  );
  if (!r.rows[0]) throw new Error('LICENSE_NOT_FOUND');
  return {
    ...r.rows[0].data,
    active: r.rows[0].active,
    observedAt: Date.now(),
    rpcCalls: 0,
  };
}
export async function centralIssue(
  license: string,
  product: string,
  issuer: Address,
  owner: Address,
  expiresAt: number,
  maxDevices: number,
  transferable = true,
) {
  const registered = await db.query<{ issuer: string }>(
    'SELECT issuer FROM research.v2_products WHERE id=$1',
    [product],
  );
  if (registered.rows[0]?.issuer.toLowerCase() !== issuer.toLowerCase())
    throw new Error('ISSUER_REQUIRED');
  if (
    !Number.isInteger(maxDevices) ||
    maxDevices < 1 ||
    maxDevices > 1000 ||
    expiresAt <= Date.now() ||
    !isAddress(owner) ||
    /^0x0+$/.test(owner)
  )
    throw new Error('INVALID_POLICY');
  const s: SnapshotV2 = {
    product: uuidToBytes16(product),
    issuer,
    owner,
    expiresAt,
    maxDevices,
    activeDevices: 0,
    revoked: false,
    transferable,
    version: 1,
    generation: 1,
    active: false,
    observedAt: Date.now(),
    blockNumber: '0',
    blockHash: '',
    rpcCalls: 0,
  };
  await db.query('INSERT INTO research.v2_licenses(id,data) VALUES($1,$2)', [
    license,
    json(s),
  ]);
}
export async function centralMutate(
  license: string,
  actor: Address,
  operation: 'activate' | 'deactivate' | 'renew' | 'transfer' | 'revoke',
  value: string | number,
  requestId: string = randomUUID(),
  generation?: number,
) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ data: SnapshotV2 }>(
      'SELECT data FROM research.v2_licenses WHERE id=$1 FOR UPDATE',
      [license],
    );
    const s = r.rows[0]?.data;
    if (!s) throw new Error('LICENSE_NOT_FOUND');
    const owner = actor.toLowerCase() === s.owner.toLowerCase(),
      issuer = actor.toLowerCase() === s.issuer.toLowerCase();
    if (
      operation === 'activate' || operation === 'transfer'
        ? !owner
        : operation === 'deactivate'
          ? !(owner || issuer)
          : !issuer
    )
      throw new Error('ACTOR_REQUIRED');
    if (operation === 'activate') {
      if (generation !== s.generation) throw new Error('GENERATION_CONFLICT');
      const payload = digest({ operation, value, generation }),
        key = digest({
          actor: actor.toLowerCase(),
          license,
          generation,
          requestId,
        });
      const previous = await c.query<{ payload: string; version: number }>(
        'SELECT payload,version FROM research.v2_requests WHERE key=$1',
        [key],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].payload !== payload)
          throw new Error('REQUEST_CONFLICT');
        await c.query('COMMIT');
        return previous.rows[0].version;
      }
      if (s.revoked || s.expiresAt <= Date.now())
        throw new Error('LICENSE_INACTIVE');
      const member = await c.query(
        'SELECT 1 FROM research.v2_devices WHERE license_id=$1 AND generation=$2 AND device=$3',
        [license, s.generation, value],
      );
      if (!member.rowCount) {
        if (s.activeDevices >= s.maxDevices) throw new Error('DEVICE_LIMIT');
        await c.query('INSERT INTO research.v2_devices VALUES($1,$2,$3)', [
          license,
          s.generation,
          value,
        ]);
        s.activeDevices++;
        s.version++;
      }
      await c.query('INSERT INTO research.v2_requests VALUES($1,$2,$3)', [
        key,
        payload,
        s.version,
      ]);
    } else if (operation === 'deactivate') {
      if (s.revoked) throw new Error('LICENSE_REVOKED');
      const removed = await c.query(
        'DELETE FROM research.v2_devices WHERE license_id=$1 AND generation=$2 AND device=$3',
        [license, s.generation, value],
      );
      if (removed.rowCount) {
        s.activeDevices--;
        s.version++;
      }
    } else if (operation === 'renew') {
      if (s.revoked) throw new Error('LICENSE_REVOKED');
      if (
        typeof value !== 'number' ||
        value <= s.expiresAt ||
        value <= Date.now()
      )
        throw new Error('INVALID_EXPIRY');
      s.expiresAt = value;
      s.version++;
    } else if (operation === 'transfer') {
      if (
        s.revoked ||
        s.expiresAt <= Date.now() ||
        !s.transferable ||
        typeof value !== 'string' ||
        !isAddress(value) ||
        value.toLowerCase() === s.owner.toLowerCase() ||
        /^0x0+$/.test(value)
      )
        throw new Error('TRANSFER_FORBIDDEN');
      s.owner = value;
      s.generation++;
      s.activeDevices = 0;
      s.version++;
    } else if (!s.revoked) {
      s.revoked = true;
      s.generation++;
      s.activeDevices = 0;
      s.version++;
    }
    await c.query('UPDATE research.v2_licenses SET data=$2 WHERE id=$1', [
      license,
      json(s),
    ]);
    await c.query('COMMIT');
    return s.version;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
