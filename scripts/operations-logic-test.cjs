const assert = require('assert');
const { rateLimitInfoFromResponse, createRateLimitGuard } = require('../lib/trueStudio');

const route = rateLimitInfoFromResponse({
  status: 429,
  headers: {
    'retry-after': '4.2',
    'x-ratelimit-reset-after': '4.2',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-limit': '5',
    'x-ratelimit-bucket': 'bucket-route',
    'x-ratelimit-scope': 'shared',
  },
  data: {},
});
assert.equal(route.exhausted, true, '429 should be exhausted');
assert.equal(route.retryAfter, 4.2, 'retry-after should be parsed');
assert.equal(route.waitMs, 4200, 'server retry interval should be preserved');
assert.equal(route.bucket, 'bucket-route');
assert.equal(route.scope, 'shared');
assert.equal(route.global, false, 'shared route must not be global');

const global = rateLimitInfoFromResponse({
  status: 429,
  headers: { 'retry-after': '1.5', 'x-ratelimit-scope': 'global' },
  data: { global: true, retry_after: 1.5 },
});
assert.equal(global.global, true, 'global response must be classified as global');
assert.equal(global.waitMs, 1500);

const remainingZero = rateLimitInfoFromResponse({
  status: 200,
  headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2.25' },
  data: {},
});
assert.equal(remainingZero.exhausted, true, 'remaining=0 with reset should be exhausted');
assert.equal(remainingZero.waitMs, 2250);

const ambiguous = rateLimitInfoFromResponse({ status: 429, headers: {}, data: {} });
assert.equal(ambiguous.exhausted, true);
assert.equal(ambiguous.global, false, 'ambiguous 429 must not be treated as global');
assert.equal(ambiguous.waitMs, 1000, 'ambiguous 429 keeps a minimum safe wait');

const guard = createRateLimitGuard({ label: 'logic-test', safetyMs: 0 });
const guarded = guard.after({
  method: 'GET',
  url: 'https://discord.com/api/v10/applications/123456789012345678',
  response: { status: 429, headers: { 'retry-after': '0', 'x-ratelimit-bucket': 'bucket-test' }, data: {} },
});
assert.equal(guarded.exhausted, true);
const snapshot = guard.snapshot();
assert.equal(snapshot.routes, 1, 'guard should remember the route');
assert.equal(snapshot.buckets, 1, 'guard should remember the bucket');

console.log('Botv3 operations logic tests passed');
