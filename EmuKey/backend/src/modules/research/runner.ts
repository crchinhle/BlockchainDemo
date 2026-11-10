import { randomUUID, randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  activationCommitment,
  planCommitment,
  uuidToBytes16,
} from '../../platform/crypto/license-crypto.js';
import {
  ResearchChain,
  db,
  redis,
  event,
  state,
  sleep,
  json,
  digest,
} from './infrastructure.js';
import { ResearchVerificationStrategy, PolicyDenied } from './verification.js';
import { summarize, type Config, type Sample } from './domain.js';

export async function runExperiment(id: string, chain: ResearchChain) {
  const claimed = await db.query<{ config: Config }>(
    "UPDATE research.runs SET state='PREPARING',heartbeat=now() WHERE id=$1 AND state='QUEUED' RETURNING config",
    [id],
  );
  if (!claimed.rows[0]) return;
  const config = claimed.rows[0].config;
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
    await db.query('UPDATE research.runs SET manifest=$2 WHERE id=$1', [
      id,
      json({
        ...(await chain.fingerprint()),
        datasetId: id,
        formulaVersion: 'observed-window-v1',
        strategyLabel:
          config.strategy === 'DIRECT_ONCHAIN'
            ? 'on-chain status + off-chain device binding'
            : config.strategy,
      }),
    ]);
    for (
      let ordinal = 1;
      ordinal <= config.repetitions && !cancelled;
      ordinal++
    ) {
      const rep = randomUUID();
      const started = Date.now();
      await db.query(
        "INSERT INTO research.repetitions(id,run_id,ordinal,state,started_at) VALUES($1,$2,$3,'PREPARING',$4)",
        [rep, id, ordinal, started],
      );
      const verifier = new ResearchVerificationStrategy(chain, config, id, rep);
      const devices: {
        license: string;
        device: string;
        account: ReturnType<typeof privateKeyToAccount>;
        old: string;
      }[] = [];
      const licenses: string[] = [];
      for (let n = 0; n < config.licenses; n++) {
        const license = randomUUID(),
          product = randomUUID(),
          plan = randomUUID();
        licenses.push(license);
        const expires =
          Math.floor((Date.now() + config.timeoutMs + 600000) / 1000) * 1000;
        const commitment = planCommitment({
          durationMonths: 1,
          entitlements: { research: true },
          maxActiveDevices: config.maxDevices,
          planId: plan,
          planVersion: 1,
          productId: product,
          providerChainAddress: chain.signer,
        });
        await chain.command(id, rep, license, 'issueLicense', [
          chain.signer,
          uuidToBytes16(product),
          uuidToBytes16(plan),
          1n,
          commitment,
          activationCommitment(`0x${randomBytes(32).toString('hex')}`),
          1n,
          BigInt(config.maxDevices),
          BigInt(expires / 1000),
        ]);
        const snapshot = await chain.snapshot(license);
        await db.query(
          'INSERT INTO research.licenses(id,run_id,product_id,expires_at,max_devices,status,block_number,block_hash,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            license,
            id,
            product,
            expires,
            config.maxDevices,
            snapshot.status,
            snapshot.blockNumber,
            snapshot.blockHash,
            snapshot.observedAt,
          ],
        );
        for (let d = 0; d < config.devices; d++) {
          const account = privateKeyToAccount(generatePrivateKey());
          const device = randomUUID();
          const challenge = await verifier.challenge(
            license,
            device,
            'activate',
          );
          await verifier.activate(
            license,
            device,
            account.address,
            challenge.nonce,
            await account.signMessage({ message: challenge.message }),
          );
          await event(id, rep, 'activated', {
            licenseId: license,
            deviceId: device,
          });
          devices.push({ license, device, account, old: '' });
        }
        await chain.command(id, rep, license, 'syncActiveDeviceCount', [
          BigInt(config.devices),
          1n,
        ]);
      }
      await state(id, 'WARMING');
      for (const device of devices) {
        const challenge = await verifier.challenge(
          device.license,
          device.device,
          'issue',
        );
        const issued = await verifier.issue(
          device.license,
          device.device,
          challenge.nonce,
          await device.account.signMessage({ message: challenge.message }),
        );
        device.old = issued.token;
        await event(id, rep, 'warmed', {
          licenseId: device.license,
          deviceId: device.device,
          expiresAt: issued.expires,
          snapshot: issued.read.snapshot,
        });
      }
      await sleep(config.warmupMs);
      const base = Date.now(),
        mono = performance.now();
      const horizon = config.revokeAfterMs + config.observeMs;
      let observationDeadline = base + horizon;
      let tc: number | null = null;
      const tcByLicense = new Map<string, number>();
      let sequence = 0;
      let revoking = false;
      let revokeTask: Promise<void> | undefined;
      const active = new Set<Promise<void>>();
      const samples: Sample[] = [];
      const pendingInvalidations = new Map<string, number>();
      let lastPoll = 0;
      let observerStopped = false;
      let referenceInvalid=false;
      const confirmedBlocks=new Map<string,{number:bigint;hash:string}>();
      const referenceMonitor=(async()=>{
        while(!observerStopped){
          for(const [license,receipt] of confirmedBlocks){try{
            const canonical=await chain.rpc.getBlock({blockNumber:receipt.number});
            const snapshot=await chain.snapshot(license);
            if(canonical.hash!==receipt.hash||snapshot.status!==3)referenceInvalid=true;
          }catch{referenceInvalid=true;}}
          if(referenceInvalid){await event(id,rep,'INVALID_FOR_ANALYSIS',{reason:'REFERENCE_REORG_OR_UNAVAILABLE'});break;}
          await sleep(200);
        }
      })();
      let checkpoint = await chain.rpc.getBlockNumber({ cacheTime: 0 });
      // Separate event consumer: durable block checkpoint, fault policy cannot affect reference observer.
      const invalidator = (async () => {
        while (!observerStopped) {
          try {
            const head = await chain.rpc.getBlockNumber({ cacheTime: 0 });
            const confirmedHead = head - BigInt(config.confirmations - 1);
            if (confirmedHead > checkpoint) {
              const logs = await chain.revocations(
                checkpoint + 1n,
                confirmedHead,
              );
              for (const log of logs) {
                const license = licenses.find(
                  (id) => uuidToBytes16(id) === log.args.licenseId,
                );
                if (
                  license &&
                  Number(log.args.status) === 3 &&
                  config.eventMode !== 'dropped'
                )
                  pendingInvalidations.set(
                    license,
                    Date.now() +
                      (config.eventMode === 'delayed'
                        ? config.eventDelayMs
                        : 0),
                  );
              }
              const block = await chain.rpc.getBlock({
                blockNumber: confirmedHead,
              });
              await db.query(
                'INSERT INTO research.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                [
                  `checkpoint:${rep}`,
                  json({
                    blockNumber: String(confirmedHead),
                    blockHash: block.hash,
                  }),
                ],
              );
              checkpoint = confirmedHead;
            }
            for (const license of licenses) {
              const due = pendingInvalidations.get(license);
              if (due !== undefined && due <= Date.now()) {
                const s = await chain.snapshot(license);
                if (s.status !== 3) throw new Error('INVALIDATION_REORG');
                await verifier.invalidate(license, s);
                pendingInvalidations.set(license, Infinity);
              }
              if (Date.now() - lastPoll >= config.pollMs) {
                const s = await chain.snapshot(license);
                if (
                  s.status === 3 &&
                  !(await redis.exists(verifier.key(license) + ':revoked'))
                )
                  await verifier.invalidate(license, s);
              }
            }
            if (Date.now() - lastPoll >= config.pollMs) lastPoll = Date.now();
          } catch {
            await event(id, rep, 'invalidation_error');
          }
          await sleep(100);
        }
      })();
      const revoke = async () => {
        await state(id, 'REVOKING');
        if (config.fault === 'rpc-outage')
          verifier.faultUntil = Date.now() + config.faultDurationMs;
        for (const license of licenses) {
          const receipt = await chain.command(
            id,
            rep,
            license,
            'revokeLicense',
            [],
          );
          // Local development node automines only transactions: mine extra empty blocks for confirmation policy.
          for (let i = 1; i < config.confirmations; i++)
            await chain.rpc.request({ method: 'evm_mine' as never } as never);
          const canonical = await chain.rpc.getBlock({
            blockNumber: receipt.blockNumber,
          });
          const snapshot = await chain.snapshot(license);
          const head = await chain.rpc.getBlockNumber({ cacheTime: 0 });
          if (
            canonical.hash !== receipt.blockHash ||
            snapshot.status !== 3 ||
            head < receipt.blockNumber + BigInt(config.confirmations - 1)
          )
            throw new Error('CONFIRMATION_OR_REORG_INVALID');
          confirmedBlocks.set(license,{number:receipt.blockNumber,hash:receipt.blockHash});
          const confirmed = Date.now();
          tcByLicense.set(license, confirmed);
          tc = tc === null ? confirmed : Math.max(tc, confirmed);
          await event(
            id,
            rep,
            'confirmed',
            {
              licenseId: license,
              txHash: receipt.transactionHash,
              blockNumber: String(receipt.blockNumber),
              blockHash: receipt.blockHash,
              chainTimestamp: snapshot.chainTimestamp,
              confirmations: config.confirmations,
            },
            confirmed,
          );
          // Explicit centralized policy command commits authority after real chain confirmation.
          await db.query(
            'UPDATE research.licenses SET status=3,block_number=$2,block_hash=$3,observed_at=$4 WHERE id=$1',
            [license, snapshot.blockNumber, snapshot.blockHash, Date.now()],
          );
          await event(id, rep, 'projection_updated', { licenseId: license });
        }
        observationDeadline = Date.now() + config.observeMs;
        await state(id, 'OBSERVING');
      };
      const probe = async (
        device: (typeof devices)[number],
        client: string,
        scheduledAt: number,
        seq: number,
      ) => {
        const start = Date.now(),
          m = performance.now();
        let evaluated: number;
        let decision = 'ALLOW',
          reason = 'AUTHORIZED';
        let metadata: Record<string, unknown> = {
          source: 'policy-before-state-read',
          rpcCalls: 0,
          cacheHit: false,
          version: null,
          generation: 1,
          blockNumber: null,
          blockHash: null,
          cacheAgeMs: null,
          tokenRemainingMs: null,
        };
        try {
          let token = device.old;
          if (client === 'refresh') {
            const ch = await verifier.challenge(
              device.license,
              device.device,
              'issue',
            );
            const issued = await verifier.issue(
              device.license,
              device.device,
              ch.nonce,
              await device.account.signMessage({ message: ch.message }),
            );
            token = issued.token;
            metadata = {
              refresh: true,
              cacheHit: issued.read.cacheHit,
              rpcCalls: issued.read.rpcCalls,
            };
          }
          const ch = await verifier.challenge(
            device.license,
            device.device,
            'verify',
          );
          const result = await verifier.verify(
            device.license,
            device.device,
            token,
            ch.nonce,
            await device.account.signMessage({ message: ch.message }),
          );
          evaluated = Date.now();
          metadata = {
            ...metadata,
            source: result.source,
            rpcCalls: Number(metadata.rpcCalls ?? 0) + result.rpcCalls,
            blockNumber: result.snapshot.blockNumber,
            blockHash: result.snapshot.blockHash,
            version: result.snapshot.version,
            generation: result.snapshot.generation,
            cacheAgeMs: evaluated - result.snapshot.observedAt,
            tokenRemainingMs: result.tokenRemainingMs,
          };
        } catch (error) {
          if (error instanceof PolicyDenied) {
            const e = error.evidence;
            metadata = {
              ...metadata,
              source: e.source,
              rpcCalls: Number(metadata.rpcCalls ?? 0) + e.rpcCalls,
              cacheHit: e.cacheHit,
              version: e.snapshot.version,
              generation: e.snapshot.generation,
              blockNumber: e.snapshot.blockNumber,
              blockHash: e.snapshot.blockHash,
              cacheAgeMs: Date.now() - e.snapshot.observedAt,
            };
          }
          evaluated = Date.now();
          reason = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
          decision =
            /TOKEN_|LICENSE_REVOKED|REPLAY|BINDING|DEVICE_NOT_BOUND/.test(
              reason,
            )
              ? 'DENY'
              : 'ERROR';
        }
        const end = Date.now(),
          latency = performance.now() - m;
        const reference = tcByLicense.get(device.license);
        const sample: Sample = {
          ...metadata,
          sequence: seq,
          client,
          decision,
          reason,
          scheduledAt,
          decisionStartedAt: start,
          decisionEvaluatedAt: evaluated,
          responseReceivedAt: end,
          latencyMs: latency,
          licenseId: device.license,
          deviceId: device.device,
          strategy: config.strategy,
          variant: config.variant,
          ambiguous:
            reference !== undefined && start < reference && end >= reference,
          stale:
            reference !== undefined &&
            start >= reference &&
            evaluated >= reference &&
            decision === 'ALLOW',
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
          (Date.now() < observationDeadline || tc === null) &&
          !cancelled
        ) {
          if(referenceInvalid)throw new Error('INVALID_FOR_ANALYSIS_REFERENCE_REORG_OR_UNAVAILABLE');
          if (Date.now() - started > config.timeoutMs)
            throw new Error('RUN_TIMEOUT');
          const elapsed = performance.now() - mono;
          if (!revoking && elapsed >= config.revokeAfterMs) {
            revoking = true;
            revokeTask = revoke();
            void revokeTask.catch(() => undefined);
          }
          const planned = tick * (1000 / config.rate);
          if (elapsed < planned) {
            await sleep(Math.min(20, planned - elapsed));
            continue;
          }
          for (const device of devices)
            for (const client of config.clients) {
              const seq = ++sequence;
              if (active.size >= config.concurrency) {
                const sample: Sample = {
                  sequence: seq,
                  decision: 'DROPPED',
                  reason: 'GENERATOR_CONCURRENCY',
                  client,
                  scheduledAt: base + planned,
                  decisionStartedAt: Date.now(),
                  decisionEvaluatedAt: Date.now(),
                  responseReceivedAt: Date.now(),
                  latencyMs: 0,
                  licenseId: device.license,
                  deviceId: device.device,
                };
                samples.push(sample);
                await db.query(
                  'INSERT INTO research.samples(run_id,repetition_id,sequence,data) VALUES($1,$2,$3,$4)',
                  [id, rep, seq, json(sample)],
                );
              } else {
                const task = probe(device, client, base + planned, seq);
                active.add(task);
                void task.finally(() => active.delete(task));
              }
            }
          tick++;
        }
        await Promise.all(active);
        await revokeTask;
        if(referenceInvalid)throw new Error('INVALID_FOR_ANALYSIS_REFERENCE_REORG_OR_UNAVAILABLE');
      } finally {
        observerStopped = true;
        await invalidator;
        await referenceMonitor;
        await Promise.allSettled(active);
      }
      samples.sort((a, b) => Number(a.sequence) - Number(b.sequence));
      const summary = {
        ...summarize(samples, tc, Date.now(), 1000 / config.rate),
        staleAccepts: samples.filter((s) => s.stale).length,
        byClient: Object.fromEntries(
          config.clients.map((client) => [
            client,
            summarize(
              samples.filter((s) => s.client === client),
              tc,
              Date.now(),
              1000 / config.rate,
            ),
          ]),
        ),
        byLicense: Object.fromEntries(
          licenses.map((license) => [
            license,
            summarize(
              samples.filter((s) => s.licenseId === license),
              tcByLicense.get(license) ?? null,
              Date.now(),
              1000 / config.rate,
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
  } catch (error) {
    await db.query('UPDATE research.runs SET error=$2 WHERE id=$1', [
      id,
      error instanceof Error ? error.message : 'FAILED',
    ]);
    await state(id, 'FAILED');
    await db.query(
      "UPDATE research.repetitions SET state='FAILED',ended_at=$2 WHERE run_id=$1 AND state NOT IN ('COMPLETED','CANCELLED')",
      [id, Date.now()],
    );
  } finally {
    clearInterval(heartbeat);
    await chain.reconcile();
    await freezeArtifact(id);
  }
}
export async function dataset(id: string) {
  const run = await db.query('SELECT * FROM research.runs WHERE id=$1', [id]);
  const reps = await db.query(
    'SELECT * FROM research.repetitions WHERE run_id=$1 ORDER BY ordinal',
    [id],
  );
  const events = await db.query(
    'SELECT * FROM research.events WHERE run_id=$1 ORDER BY id',
    [id],
  );
  const rows = await db.query<{
    id: string;
    repetition_id: string;
    data: Sample;
  }>(
    'SELECT * FROM research.samples WHERE run_id=$1 ORDER BY repetition_id,sequence',
    [id],
  );
  const samples = rows.rows.map((r) => ({
    ...r.data,
    id: r.id,
    repetition_id: r.repetition_id,
  }));
  return {
    schemaVersion: 1,
    formulaVersion: 'observed-window-v1',
    run: run.rows[0] as Record<string, unknown>,
    repetitions: reps.rows as Record<string, unknown>[],
    events: events.rows as Record<string, unknown>[],
    samples,
  };
}
export async function freezeArtifact(id: string) {
  const data = await dataset(id);
  await db.query(
    'INSERT INTO research.artifacts(run_id,data,checksum) VALUES($1,$2,$3) ON CONFLICT(run_id) DO NOTHING',
    [id, json(data), digest(data)],
  );
}
