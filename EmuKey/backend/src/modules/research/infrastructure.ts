import canonicalize from 'canonicalize';
import { ConfigService } from '@nestjs/config';
import { DatabasePool } from '../../platform/database/database-pool.js';
import { RedisClient } from '../../platform/redis/redis-client.js';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbiItem,
  type PublicClient,
  type WalletClient,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { hardhat } from 'viem/chains';
import { uuidToBytes16 } from '../../platform/crypto/license-crypto.js';

export const json = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
export const digest = (value: unknown) =>
  createHash('sha256')
    .update(canonicalize(JSON.parse(json(value)) as unknown)!)
    .digest('hex');
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
const config = new ConfigService({
  DATABASE_URL:
    process.env.RESEARCH_DATABASE_URL ??
    'postgres://research:local-research-only@127.0.0.1:55432/emukey_research',
  REDIS_URL: process.env.RESEARCH_REDIS_URL ?? 'redis://127.0.0.1:56379',
});
export const db = new DatabasePool(config);
export const redis = new RedisClient(config);
export async function initialize() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('RESEARCH_LOCAL_ONLY');
  // Docker's one-shot database-initialize service owns SQL creation. Runtime only checks it.
  await db.query('SELECT id FROM research.runs LIMIT 0');
  if (redis.status === 'wait') await redis.connect();
}
export async function event(
  run: string,
  rep: string | null,
  kind: string,
  data: unknown = {},
  at = Date.now(),
) {
  await db.query(
    'INSERT INTO research.events(run_id,repetition_id,kind,at,data) VALUES($1,$2,$3,$4,$5)',
    [run, rep, kind, at, json(data)],
  );
}
export async function state(run: string, state: string) {
  await db.query(
    'UPDATE research.runs SET state=$2,heartbeat=now() WHERE id=$1',
    [run, state],
  );
  await event(run, null, state);
}

export class ResearchChain {
  readonly rpc: PublicClient = createPublicClient({
    chain: hardhat,
    transport: http(process.env.RESEARCH_RPC_URL ?? 'http://127.0.0.1:58545', {
      timeout: 3000,
      retryCount: 0,
    }),
  });
  readonly wallet: WalletClient = createWalletClient({
    chain: hardhat,
    transport: http(process.env.RESEARCH_RPC_URL ?? 'http://127.0.0.1:58545', {
      timeout: 3000,
      retryCount: 0,
    }),
  });
  address!: Address;
  signer!: Address;
  abi!: Abi;
  bytecode!: Hex;
  async init(deploy = false) {
    if ((await this.rpc.getChainId()) !== 31337)
      throw new Error('LOCAL_CHAIN_ID_REQUIRED');
    const artifact = JSON.parse(
      await readFile(
        'contracts/artifacts/solidity/LicenseRegistry.sol/LicenseRegistry.json',
        'utf8',
      ),
    ) as { abi: Abi; bytecode: Hex };
    this.abi = artifact.abi;
    this.bytecode = artifact.bytecode;
    [this.signer] = (await this.wallet.getAddresses()) as [Address];
    if (!this.signer) throw new Error('LOCAL_SIGNER_REQUIRED');
    const stored = await db.query<{ value: { address: Address } }>(
      "SELECT value FROM research.settings WHERE key='deployment'",
    );
    const address = stored.rows[0]?.value.address;
    if (address && (await this.rpc.getCode({ address }))) {
      this.address = address;
      return;
    }
    if (!deploy) throw new Error('DEPLOY_RESEARCH_CONTRACT_FIRST');
    const hash = await this.wallet.deployContract({
      abi: this.abi,
      bytecode: this.bytecode,
      args: [this.signer, this.signer],
      account: this.signer,
      chain: hardhat,
    });
    const receipt = await this.rpc.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress)
      throw new Error('DEPLOY_FAILED');
    this.address = receipt.contractAddress;
    await db.query(
      "INSERT INTO research.settings(key,value) VALUES('deployment',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [
        json({
          address: this.address,
          hash,
          block: receipt.blockNumber,
          abiHash: digest(this.abi),
          bytecodeHash: digest(this.bytecode),
        }),
      ],
    );
  }
  async snapshot(licenseId: string) {
    const block = await this.rpc.getBlock();
    const value = (await this.rpc.readContract({
      address: this.address,
      abi: this.abi,
      functionName: 'getLicense',
      args: [uuidToBytes16(licenseId)],
      blockNumber: block.number,
    })) as {
      status: number;
      expiresAt: bigint;
      activationKeyVersion: bigint;
      deviceStateVersion: bigint;
    };
    const canonical = await this.rpc.getBlock({ blockNumber: block.number });
    if (canonical.hash !== block.hash) throw new Error('REORG_SNAPSHOT');
    return {
      status:
        value.status === 1 && Number(value.expiresAt) * 1000 <= Date.now()
          ? 4
          : value.status,
      expiresAt: Number(value.expiresAt) * 1000,
      version: Number(value.activationKeyVersion),
      generation: 1,
      blockNumber: String(block.number),
      blockHash: block.hash,
      observedAt: Date.now(),
      chainTimestamp: Number(block.timestamp) * 1000,
      rpcCalls: 3,
    };
  }
  async command(
    run: string,
    rep: string,
    license: string,
    kind: string,
    args: unknown[],
    submitted?: (hash: Hex) => Promise<void>,
  ) {
    const id = randomUUID();
    const payloadHash = digest({ kind, args });
    const inserted = await db.query<{
      id: string;
      payload_hash: string;
      tx_hash: Hex | null;
      state: string;
    }>(
      "INSERT INTO research.commands(id,run_id,license_id,kind,payload_hash,state) VALUES($1,$2,$3,$4,$5,'PREPARING') ON CONFLICT(license_id,kind) DO UPDATE SET id=research.commands.id RETURNING *",
      [id, run, license, kind, payloadHash],
    );
    const command = inserted.rows[0]!;
    if (command.payload_hash !== payloadHash)
      throw new Error('COMMAND_PAYLOAD_CONFLICT');
    if (command.id !== id)
      throw new Error('COMMAND_ALREADY_EXISTS_RECONCILE_ONLY');
    // Never automatically resubmit after a crash. Persist intent before sending, then reconcile.
    await event(run, rep, `${kind}_submit`, {
      commandId: id,
      licenseId: license,
    });
    const hash = await this.wallet.writeContract({
      address: this.address,
      abi: this.abi,
      functionName: kind,
      args: [uuidToBytes16(id), uuidToBytes16(license), ...args],
      account: this.signer,
      chain: hardhat,
    });
    await db.query(
      "UPDATE research.commands SET tx_hash=$2,state='PENDING' WHERE id=$1",
      [id, hash],
    );
    await event(run, rep, `${kind}_broadcast`, {
      commandId: id,
      licenseId: license,
      txHash: hash,
    });
    await submitted?.(hash);
    const receipt = await this.rpc.waitForTransactionReceipt({
      hash,
      timeout: 30000,
      pollingInterval: 100,
    });
    await db.query(
      'UPDATE research.commands SET state=$2,receipt=$3 WHERE id=$1',
      [
        id,
        receipt.status === 'success' ? 'INCLUDED' : 'REVERTED',
        json(receipt),
      ],
    );
    await event(
      run,
      rep,
      `${kind}_${receipt.status === 'success' ? 'included' : 'reverted'}`,
      {
        txHash: hash,
        blockNumber: String(receipt.blockNumber),
        blockHash: receipt.blockHash,
        gasUsed: String(receipt.gasUsed),
        fee: String(receipt.gasUsed * receipt.effectiveGasPrice),
      },
    );
    if (receipt.status !== 'success') throw new Error('TRANSACTION_REVERTED');
    return receipt;
  }
  async reconcile() {
    const commands = await db.query<{
      id: string;
      tx_hash: Hex | null;
      license_id: string;
      run_id: string;
    }>(
      "SELECT id,tx_hash,license_id,run_id FROM research.commands WHERE state IN ('PREPARING','PENDING','INCLUDED')",
    );
    for (const c of commands.rows) {
      if (!c.tx_hash) {
        const consumed = await this.rpc.readContract({
          address: this.address,
          abi: this.abi,
          functionName: 'processedCommands',
          args: [uuidToBytes16(c.id)],
        });
        await db.query('UPDATE research.commands SET state=$2 WHERE id=$1', [
          c.id,
          consumed ? 'CONSUMED_RECEIPT_UNKNOWN' : 'INTERRUPTED_NO_RETRY',
        ]);
        continue;
      }
      try {
        const receipt = await this.rpc.getTransactionReceipt({
          hash: c.tx_hash,
        });
        await db.query(
          'UPDATE research.commands SET state=$2,receipt=$3 WHERE id=$1',
          [
            c.id,
            receipt.status === 'success' ? 'RECONCILED' : 'REVERTED',
            json(receipt),
          ],
        );
      } catch {
        /* Pending is retained for next reconciliation; never fabricate cancellation. */
      }
    }
  }
  async revocations(fromBlock: bigint, toBlock: bigint) {
    return this.rpc.getLogs({
      address: this.address,
      event: parseAbiItem(
        'event LicenseStatusChanged(bytes16 indexed commandId, bytes16 indexed licenseId, uint8 status)',
      ),
      fromBlock,
      toBlock,
    });
  }
  async fingerprint() {
    const files = (await readdir('src/modules/research'))
      .filter((f) => f.endsWith('.ts'))
      .sort();
    const codeHash = digest(
      await Promise.all(
        [
          ...files.map((f) => 'src/modules/research/' + f),
          'src/entrypoints/research/main.ts',
          'database/research.sql',
        ].map(async (path) => ({
          path,
          hash: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        })),
      ),
    );
    return {
      codeHash,
      appCommit: null,
      hashAlgorithm: 'SHA256 RFC8785 canonical JSON',
      chainInstance: (await this.rpc.getBlock({ blockNumber: 0n })).hash,
      network: 'research-local',
      chainId: 31337,
      contract: this.address,
      abiHash: digest(this.abi),
      bytecodeHash: keccak256(
        (await this.rpc.getCode({ address: this.address }))!,
      ),
      sourceCommit: '8357c8c1ca7af68ff36bd5bc87641702d6679f27',
      clock:
        'single worker process: Date.now UTC milliseconds + performance.now duration',
      clockSkewBoundMs: null,
      node: process.version,
      mock: false,
    };
  }
}
