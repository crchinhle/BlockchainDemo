import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { uuidToBytes16 } from '../../platform/crypto/license-crypto.js';
import {
  db,
  json,
  event,
  state,
  sleep,
  runtimeCodeHash,
} from './infrastructure.js';
import {
  ChainV2,
  VerifierV2,
  centralIssue,
  centralMutate,
  deviceIdentity,
  decisionMetrics,
} from './protocol-v2.js';
import { summarize, type Config, type Sample } from './domain.js';
import { freezeArtifact } from './runner.js';

export async function runExperimentV2(id: string, chain: ChainV2) {
  const claim = await db.query<{ config: Config }>(
    "UPDATE research.runs SET state='PREPARING',heartbeat=now() WHERE id=$1 AND state='QUEUED' RETURNING config",
    [id],
  );
  if (!claim.rows[0]) return;
  const c = claim.rows[0].config,
    central = c.strategy === 'CENTRALIZED';
  let cancelled = false;
  const heartbeat = setInterval(() => {
    void db
      .query<{ cancel_requested: boolean }>(
        'UPDATE research.runs SET heartbeat=now() WHERE id=$1 RETURNING cancel_requested',
        [id],
      )
      .then((r) => {
        cancelled = r.rows[0]?.cancel_requested ?? false;
      })
      .catch(() => {
        cancelled = true;
      });
  }, 500);
  try {
    if (!central) await chain.init();
    // Central authority principals are application identities, not transactions or RPC accounts.
    const issuer: Address = central
      ? '0x0000000000000000000000000000000000000001'
      : chain.signer;
    const owner: Address = central
      ? '0x0000000000000000000000000000000000000002'
      : chain.owner;
    const manifest = central
      ? {
          codeHash: await runtimeCodeHash(),
          chainId: null,
          contract: null,
          mock: false,
          network: 'postgres-local',
        }
      : await chain.fingerprint();
    await db.query('UPDATE research.runs SET manifest=$2 WHERE id=$1', [
      id,
      json({
        ...manifest,
        appCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
        modelVersion: 2,
        measurementBoundary:
          'in-process complete proof/token/decision; not HTTP network latency',
        reference: central
          ? 'database commit acknowledgement'
          : 'canonical receipt plus configured confirmations',
        tokenAlgorithm: 'ES256',
        formula:
          'min(iat+T, observation-start+min(C,freshness), license expiry)',
        deltaBoundMs: null,
        epsilonBoundMs: null,
        datasetId: id,
        strategyLabel: c.strategy,
        formulaVersion: 'observed-window-v1',
      }),
    ]);
    for (let ordinal = 1; ordinal <= c.repetitions && !cancelled; ordinal++) {
      const rep = randomUUID(),
        samples: Sample[] = [],
        licenses: string[] = [],
        tcByLicense = new Map<string, number>();
      await db.query(
        "INSERT INTO research.repetitions(id,run_id,ordinal,state,started_at) VALUES($1,$2,$3,'PREPARING',$4)",
        [rep, id, ordinal, Date.now()],
      );
      const verifier = new VerifierV2(
        chain,
        c.strategy as 'CENTRALIZED' | 'DIRECT_ONCHAIN' | 'HYBRID',
        id + ':' + rep,
        Math.min(c.cacheTtlMs, c.freshnessMs),
        c.tokenTtlMs,
        c.confirmations,
      );
      const devices: {
        license: string;
        product: string;
        account: ReturnType<typeof privateKeyToAccount>;
        token: string;
      }[] = [];
      const tx = async (
        actor: Address,
        operation: string,
        args: unknown[],
        license: string,
      ) => {
        const commandId = randomUUID(),
          submittedAt = Date.now();
        await db.query(
          "INSERT INTO research.v2_commands(id,run_id,contract,actor,operation,payload,state) VALUES($1,$2,$3,$4,$5,$6,'PREPARING')",
          [commandId, id, chain.address, actor, operation, json(args)],
        );
        await event(
          id,
          rep,
          operation + '_submit',
          { licenseId: license, commandId },
          submittedAt,
        );
        const hash = await chain.wallet.writeContract({
          address: chain.address,
          abi: chain.abi,
          functionName: operation,
          args,
          account: actor,
          chain: chain.wallet.chain,
        });
        await db.query(
          "UPDATE research.v2_commands SET hash=$2,state='PENDING' WHERE id=$1",
          [commandId, hash],
        );
        await event(id, rep, operation + '_broadcast', {
          licenseId: license,
          txHash: hash,
          commandId,
        });
        const receipt = await chain.rpc.waitForTransactionReceipt({
          hash,
          timeout: 30000,
          pollingInterval: 100,
        });
        await db.query(
          'UPDATE research.v2_commands SET state=$2,receipt=$3 WHERE id=$1',
          [
            commandId,
            receipt.status === 'success' ? 'INCLUDED' : 'REVERTED',
            json(receipt),
          ],
        );
        await event(id, rep, operation + '_included', {
          licenseId: license,
          txHash: hash,
          status: receipt.status,
          gasUsed: String(receipt.gasUsed),
          blockNumber: String(receipt.blockNumber),
          blockHash: receipt.blockHash,
        });
        if (receipt.status !== 'success')
          throw new Error('TRANSACTION_REVERTED');
        for (let i = 1; i < c.confirmations; i++)
          await chain.rpc.request({ method: 'evm_mine' as never } as never);
        if (
          (await chain.rpc.getBlock({ blockNumber: receipt.blockNumber }))
            .hash !== receipt.blockHash
        )
          throw new Error('REFERENCE_REORG');
        return receipt;
      };
      for (let n = 0; n < c.licenses; n++) {
        const license = randomUUID(),
          product = randomUUID(),
          expiry =
            Math.floor((Date.now() + c.timeoutMs + 600000) / 1000) * 1000;
        licenses.push(license);
        if (central) {
          await db.query('INSERT INTO research.v2_products VALUES($1,$2)', [
            product,
            issuer,
          ]);
          await centralIssue(
            license,
            product,
            issuer,
            owner,
            expiry,
            c.maxDevices,
          );
        } else {
          await tx(
            issuer,
            'registerProduct',
            [uuidToBytes16(product), issuer],
            license,
          );
          await tx(
            issuer,
            'issue',
            [
              uuidToBytes16(license),
              uuidToBytes16(product),
              owner,
              BigInt(expiry / 1000),
              c.maxDevices,
              true,
            ],
            license,
          );
        }
        for (let j = 0; j < c.devices; j++) {
          const account = privateKeyToAccount(generatePrivateKey()),
            device = deviceIdentity(license, account.address),
            requestId = keccak256(toHex(randomUUID()));
          if (central)
            await centralMutate(
              license,
              owner,
              'activate',
              device,
              requestId,
              1,
            );
          else
            await tx(
              owner,
              'activate',
              [uuidToBytes16(license), device, 1n, requestId],
              license,
            );
          devices.push({ license, product, account, token: '' });
          await event(id, rep, 'activated', {
            licenseId: license,
            deviceId: device,
          });
        }
      }
      await state(id, 'WARMING');
      const proof = async (d: (typeof devices)[number]) => {
        const p = await verifier.challenge(
          d.license,
          d.product,
          d.account.address,
        );
        return [
          p.nonce,
          await d.account.signMessage({ message: p.message }),
        ] as [string, Hex];
      };
      for (const d of devices) {
        const issued = await verifier.issue(
          d.license,
          d.product,
          d.account.address,
          ...(await proof(d)),
        );
        d.token = issued.token;
        await event(id, rep, 'warmed', {
          licenseId: d.license,
          expiresAt: issued.deadline,
          snapshot: issued.snapshot,
        });
      }
      await sleep(c.warmupMs);
      const start = Date.now(),
        mono = performance.now();
      let stop = false,
        invalid = false,
        lastPoll = 0,
        faultUntil = 0,
        sequence = 0;
      const confirmed = new Map<string, { number: bigint; hash: string }>();
      const originalRead = chain.read.bind(chain);
      // Faults affect verifier reads only; observer uses a separate chain instance.
      const reference = new ChainV2();
      if (!central) await reference.init();
      chain.read = async (...args) => {
        if (Date.now() < faultUntil) throw new Error('RPC_OUTAGE_INJECTED');
        const s = await originalRead(...args);
        if (c.fault === 'cache-race') await sleep(c.faultDurationMs);
        return s;
      };
      const monitor = (async () => {
        while (!stop) {
          try {
            if (!central) {
              for (const receipt of confirmed.values())
                if (
                  (
                    await reference.rpc
                      .getBlock({
                        blockNumber: receipt.number,
                      })
                      .catch(() => {
                        throw new Error('REFERENCE_UNAVAILABLE');
                      })
                  ).hash !== receipt.hash
                )
                  throw new Error('REFERENCE_REORG');
              if (c.strategy === 'HYBRID') {
                await verifier.synchronize(
                  licenses,
                  rep,
                  c.eventMode === 'dropped',
                  c.eventMode === 'delayed' ? c.eventDelayMs : 0,
                );
                if (Date.now() - lastPoll >= c.pollMs) {
                  for (const license of licenses) {
                    const s = await reference.read(
                      license,
                      ('0x' + '00'.repeat(32)) as Hex,
                      c.confirmations,
                    );
                    await verifier.invalidate(license, s);
                  }
                  lastPoll = Date.now();
                }
              }
            }
          } catch (e) {
            await event(id, rep, 'invalidation_error', {
              reason: e instanceof Error ? e.message : 'unknown',
            });
            if (
              e instanceof Error &&
              /REORG|REFERENCE_UNAVAILABLE/.test(e.message)
            )
              invalid = true;
          }
          await sleep(100);
        }
      })();
      let revocation: Promise<void> | undefined,
        deadline = start + c.revokeAfterMs + c.observeMs;
      const revoke = async () => {
        await state(id, 'REVOKING');
        if (c.fault === 'rpc-outage')
          faultUntil = Date.now() + c.faultDurationMs;
        for (const license of licenses) {
          if (central) {
            await event(id, rep, 'revoke_submit', { licenseId: license });
            await centralMutate(license, issuer, 'revoke', '');
            const at = Date.now();
            tcByLicense.set(license, at);
            await event(
              id,
              rep,
              'central_committed',
              { licenseId: license },
              at,
            );
          } else {
            const r = await tx(
              issuer,
              'revoke',
              [uuidToBytes16(license)],
              license,
            );
            confirmed.set(license, {
              number: r.blockNumber,
              hash: r.blockHash,
            });
            const at = Date.now();
            tcByLicense.set(license, at);
            await event(
              id,
              rep,
              'confirmed',
              {
                licenseId: license,
                txHash: r.transactionHash,
                blockNumber: String(r.blockNumber),
                blockHash: r.blockHash,
                confirmations: c.confirmations,
              },
              at,
            );
          }
        }
        deadline = Date.now() + c.observeMs;
        await state(id, 'OBSERVING');
      };
      const active = new Set<Promise<void>>();
      const probe = async (
        d: (typeof devices)[number],
        client: string,
        scheduledAt: number,
        seq: number,
      ) => {
        const began = Date.now(),
          m = performance.now();
        let decision = 'ALLOW',
          reason = 'AUTHORIZED',
          metadata: Record<string, unknown> = {};
        const metrics = { rpcCalls: 0, cacheHits: 0 };
        await decisionMetrics.run(metrics, async () => {
          try {
            let token = d.token;
            if (client === 'refresh') {
              const issued = await verifier.issue(
                d.license,
                d.product,
                d.account.address,
                ...(await proof(d)),
              );
              token = issued.token;
            }
            const s = await verifier.verify(
              d.license,
              d.product,
              d.account.address,
              token,
              ...(await proof(d)),
            );
            metadata = {
              version: s.version,
              generation: s.generation,
              blockNumber: s.blockNumber,
              blockHash: s.blockHash,
              cacheAgeMs: Date.now() - s.observedAt,
            };
          } catch (e) {
            reason = e instanceof Error ? e.message : 'UNKNOWN';
            decision =
              /TOKEN_|LICENSE_|PRODUCT_|PROOF_|REPLAY|JWT|signature|exp.*claim/i.test(
                reason,
              )
                ? 'DENY'
                : 'ERROR';
          }
        });
        const end = Date.now(),
          tc = tcByLicense.get(d.license);
        const sample: Sample = {
          ...metadata,
          sequence: seq,
          client,
          decision,
          reason,
          rpcCalls: metrics.rpcCalls,
          cacheHit: metrics.cacheHits > 0,
          cacheReads: metrics.cacheHits,
          scheduledAt,
          decisionStartedAt: began,
          decisionEvaluatedAt: end,
          responseReceivedAt: end,
          latencyMs: performance.now() - m,
          licenseId: d.license,
          deviceId: deviceIdentity(d.license, d.account.address),
          strategy: c.strategy,
          variant: 'onchain-membership-v2',
          ambiguous: tc !== undefined && began < tc && end >= tc,
          stale: tc !== undefined && began >= tc && decision === 'ALLOW',
        };
        samples.push(sample);
        await db.query(
          'INSERT INTO research.samples(run_id,repetition_id,sequence,data) VALUES($1,$2,$3,$4)',
          [id, rep, seq, json(sample)],
        );
      };
      await state(id, 'RUNNING');
      let tick = 0;
      try {
        while (
          !cancelled &&
          (Date.now() < deadline || tcByLicense.size < licenses.length)
        ) {
          if (invalid) throw new Error('INVALID_FOR_ANALYSIS_REFERENCE_REORG');
          if (Date.now() - start > c.timeoutMs) throw new Error('RUN_TIMEOUT');
          const elapsed = performance.now() - mono;
          if (!revocation && elapsed >= c.revokeAfterMs) {
            revocation = revoke();
            void revocation.catch(() => undefined);
          }
          const planned = (tick * 1000) / c.rate;
          if (elapsed < planned) {
            await sleep(Math.min(20, planned - elapsed));
            continue;
          }
          for (const d of devices)
            for (const client of c.clients) {
              const seq = ++sequence;
              if (active.size >= c.concurrency) {
                const at = Date.now();
                const s: Sample = {
                  sequence: seq,
                  client,
                  decision: 'DROPPED',
                  reason: 'GENERATOR_CONCURRENCY',
                  scheduledAt: start + planned,
                  decisionStartedAt: at,
                  decisionEvaluatedAt: at,
                  responseReceivedAt: at,
                  latencyMs: 0,
                  licenseId: d.license,
                };
                samples.push(s);
                await db.query(
                  'INSERT INTO research.samples(run_id,repetition_id,sequence,data) VALUES($1,$2,$3,$4)',
                  [id, rep, seq, json(s)],
                );
              } else {
                const task = probe(d, client, start + planned, seq);
                active.add(task);
                void task.then(
                  () => active.delete(task),
                  () => active.delete(task),
                );
              }
            }
          tick++;
        }
        await Promise.all(active);
        await revocation;
      } finally {
        stop = true;
        await monitor;
        await Promise.allSettled(active);
        if (revocation) await Promise.allSettled([revocation]);
        chain.read = originalRead;
      }
      if (invalid)
        throw new Error('INVALID_FOR_ANALYSIS_REFERENCE_REORG_OR_UNAVAILABLE');
      samples.sort((a, b) => a.decisionEvaluatedAt - b.decisionEvaluatedAt);
      const tc = tcByLicense.size ? Math.max(...tcByLicense.values()) : null;
      const summary = {
        ...summarize(samples, tc, Date.now(), 1000 / c.rate),
        staleAccepts: samples.filter((s) => s.stale).length,
        byClient: Object.fromEntries(
          c.clients.map((client) => [
            client,
            summarize(
              samples.filter((s) => s.client === client),
              tc,
              Date.now(),
              1000 / c.rate,
            ),
          ]),
        ),
        byLicense: Object.fromEntries(
          licenses.map((l) => [
            l,
            summarize(
              samples.filter((s) => s.licenseId === l),
              tcByLicense.get(l) ?? null,
              Date.now(),
              1000 / c.rate,
            ),
          ]),
        ),
      };
      await db.query(
        'UPDATE research.repetitions SET state=$2,ended_at=$3,tc=$4,summary=$5 WHERE id=$1',
        [
          rep,
          cancelled ? 'CANCELLED' : 'COMPLETED',
          Date.now(),
          tc,
          json(summary),
        ],
      );
    }
    await state(id, cancelled ? 'CANCELLED' : 'COMPLETED');
  } catch (e) {
    await db.query('UPDATE research.runs SET error=$2 WHERE id=$1', [
      id,
      e instanceof Error ? e.message : 'FAILED',
    ]);
    await state(id, 'FAILED');
    await db.query(
      "UPDATE research.repetitions SET state='FAILED',ended_at=$2 WHERE run_id=$1 AND state NOT IN ('COMPLETED','CANCELLED')",
      [id, Date.now()],
    );
  } finally {
    clearInterval(heartbeat);
    await freezeArtifact(id);
  }
}

export async function reconcileV2(chain: ChainV2) {
  const rows = await db.query<{
    id: string;
    hash: Hex | null;
    contract: string;
  }>(
    "SELECT id,hash,contract FROM research.v2_commands WHERE state IN ('PREPARING','PENDING')",
  );
  for (const row of rows.rows) {
    if (!row.hash) {
      await db.query(
        "UPDATE research.v2_commands SET state='INTERRUPTED_OUTCOME_UNKNOWN' WHERE id=$1",
        [row.id],
      );
      continue;
    }
    try {
      const r = await chain.rpc.getTransactionReceipt({ hash: row.hash });
      if (
        r.to?.toLowerCase() !== row.contract.toLowerCase() ||
        (await chain.rpc.getBlock({ blockNumber: r.blockNumber })).hash !==
          r.blockHash
      )
        continue;
      await db.query(
        'UPDATE research.v2_commands SET state=$2,receipt=$3 WHERE id=$1',
        [row.id, r.status === 'success' ? 'RECONCILED' : 'REVERTED', json(r)],
      );
    } catch {
      /* Keep unknown; never retransmit. */
    }
  }
}
