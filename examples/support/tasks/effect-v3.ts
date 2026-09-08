import assert from 'node:assert/strict';
import { all, fail, retry, runPromise, succeed, suspend, sync } from 'effect-v3/Effect';

let attempts = 0;
const flaky = suspend(() => ++attempts < 3 ? fail('transient') : succeed('recovered'));
assert.equal(await runPromise(retry(flaky, { times: 2 })), 'recovered');
assert.equal(attempts, 3);

let failedAttempts = 0;
const exhausted = suspend(() => { failedAttempts++; return fail('exhausted'); });
await assert.rejects(runPromise(retry(exhausted, { times: 2 })));
assert.equal(failedAttempts, 3);

const order: number[] = [];
const jobs = [1, 2, 3].map(n => sync(() => { order.push(n); return n * 10; }));
assert.deepEqual(await runPromise(all(jobs, { concurrency: 1 })), [10, 20, 30]);
assert.deepEqual(order, [1, 2, 3]);
