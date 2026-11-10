import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenDeadline, validateConfig, summarize, csv } from '../../../EmuKey/backend/dist/modules/research/domain.js';
test('snapshot deadline never slides and caps long token TTL', () => {
  assert.equal(tokenDeadline(1200, 1000, 5000, 10000, 9000), 6000);
  assert.equal(tokenDeadline(3000, 1000, 5000, 10000, 9000), 6000);
  assert.equal(tokenDeadline(1200, 1000, 5000, 10000, 2000), 2000);
});
test('reject zero TTL and unbounded workload', () => {
  assert.throws(() => validateConfig({cacheTtlMs:0}));
  assert.throws(() => validateConfig({rate:100000}));
  assert.throws(() => validateConfig({devices:3,maxDevices:1}));
});
test('in-flight allow is not definite stale; no stale means unknown window', () => {
  const s = summarize([{decision:'ALLOW',decisionStartedAt:90,decisionEvaluatedAt:99,responseReceivedAt:110,latencyMs:20,client:'old-token'}],100,200,100);
  assert.equal(s.staleAccepts,0); assert.equal(s.observedWindowMs,null);
});
test('last stale accept, not first deny; censor at horizon', () => {
  const s = summarize([{decision:'DENY',decisionStartedAt:110,decisionEvaluatedAt:111,responseReceivedAt:112,latencyMs:2,client:'old-token'}, {decision:'ALLOW',decisionStartedAt:190,decisionEvaluatedAt:191,responseReceivedAt:192,latencyMs:2,client:'old-token'}],100,200,100);
  assert.equal(s.staleAccepts,1); assert.equal(s.observedWindowMs,91); assert.equal(s.rightCensored,true);
});
test('CSV neutralizes formulas and escapes quotes', () => {assert.equal(csv([{x:'=1+1'}],['x']),'x\n"\'=1+1"\n');});
