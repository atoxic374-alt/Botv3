const assert = require('assert');

const base = process.env.BOTV3_BASE_URL || 'http://127.0.0.1:5190';

async function json(path, options) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) {}
  return { res, text, body };
}

(async () => {
  const health = await json('/api/healthz');
  assert.equal(health.res.status, 200, 'healthz should be reachable');
  assert.deepEqual(health.body, { status: 'ok', service: 'botv3' }, 'healthz should identify Botv3');

  const state = await json('/api/ts/state');
  assert.equal(state.res.status, 200, 'state should be reachable');
  assert.equal(state.body?.success, true, 'state should succeed');

  const profiles = await json('/api/ts/profiles');
  assert.equal(profiles.res.status, 200, 'profiles should be reachable');
  assert.equal(profiles.body?.success, true, 'profiles should succeed');

  const missingLibrary = await json('/api/ts/library');
  assert.equal(missingLibrary.res.status, 200, 'library validation should return JSON');
  assert.equal(missingLibrary.body?.success, false, 'library without account should fail safely');

  const missingJoinEmail = await json('/api/ts/join-server', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteUrl: 'https://discord.gg/example' }),
  });
  assert.equal(missingJoinEmail.body?.success, false, 'joining without an account should fail safely');

  const invalidJoinHost = await json('/api/ts/join-server', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@invalid.test', inviteUrl: 'https://example.com/invite/example' }),
  });
  assert.equal(invalidJoinHost.body?.success, false, 'non-Discord invite hosts should be rejected');
  assert.match(invalidJoinHost.body?.error || '', /Discord/i, 'invalid invite host error should be explicit');

  const unknownLibrary = await json('/api/ts/library?email=smoke%40invalid.test');
  assert.equal(unknownLibrary.body?.success, false, 'library with unknown account should fail safely');

  const tokenWithoutPassword = await json('/api/ts/accounts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke-token-only@example.invalid', directToken: 'fake-discord-user-token-1234567890' }),
  });
  assert.equal(tokenWithoutPassword.body?.success, true, 'existing account connection should accept a direct token without password');
  assert.equal(tokenWithoutPassword.body?.account?.hasDirectToken, true, 'direct token connection should be stored');

  const normalizedToken = await json('/api/ts/accounts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'smoke-normalized-token@example.invalid',
      password: 'smoke-password',
      directToken: 'Authorization: Bearer fake-discord-token-1234567890',
    }),
  });
  assert.equal(normalizedToken.body?.success, true, 'complete Authorization/Bearer token should be accepted');
  assert.equal(normalizedToken.body?.account?.hasDirectToken, true, 'normalized token should be stored');

  const shortToken = await json('/api/ts/accounts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'smoke-short-token@example.invalid',
      password: 'smoke-password',
      directToken: 'short-token',
    }),
  });
  assert.equal(shortToken.body?.success, false, 'short direct token should be rejected');
  assert.match(shortToken.body?.error || '', /too short/i, 'short token error should be explicit');

  const teamsWithoutEmail = await json('/api/ts/teams');
  assert.equal(teamsWithoutEmail.body?.success, false, 'teams without account should fail safely');

  const createTeamWithoutAccount = await json('/api/ts/teams/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@invalid.test', name: 'Smoke Team' }),
  });
  assert.equal(createTeamWithoutAccount.body?.success, false, 'team creation without saved account should fail safely');

  const invalidTeamCount = await json('/api/ts/teams/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@invalid.test', name: 'Smoke Team', count: 31 }),
  });
  assert.equal(invalidTeamCount.body?.success, false, 'team count above Discord limit should be rejected');
  assert.match(invalidTeamCount.body?.error || '', /between 1 and 30/i, 'team count error should be explicit');

  const addAppInvalid = await json('/api/ts/teams/team/add-app', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@invalid.test' }),
  });
  assert.equal(addAppInvalid.body?.success, false, 'team app transfer with invalid payload should fail safely');

  const startInvalid = await json('/api/ts/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(startInvalid.body?.success, false, 'invalid session start should fail safely');

  const resetStartInvalid = await json('/api/ts/reset-all/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@invalid.test', bots: [] }),
  });
  assert.equal(resetStartInvalid.body?.success, false, 'invalid Reset All payload should fail safely');

  const resetStopIdle = await json('/api/ts/reset-all/stop', { method: 'POST' });
  assert.equal(resetStopIdle.body?.success, true, 'Reset All stop should be safe while idle');

  const profile = await json('/api/ts/profiles', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke Profile', config: { rules: { createBots: true }, count: 2, prefix: 'Smoke' } }),
  });
  assert.equal(profile.body?.success, true, 'profile should save');
  const profileId = profile.body?.profile?.id;
  assert.ok(profileId, 'saved profile should have an id');

  const dry = await json('/api/ts/dry-run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { createBots: true }, count: 2, prefix: 'Smoke' }),
  });
  assert.equal(dry.res.status, 200, 'dry run should return HTTP 200 for validation failures');
  assert.equal(dry.body?.success, true, 'dry run response should succeed');
  assert.equal(dry.body?.ok, false, 'dry run without account should fail safely');
  assert.ok(Array.isArray(dry.body?.checks) && dry.body.checks.length >= 5, 'dry run should return checks');

  const csv = await json('/api/ts/export?format=csv');
  assert.equal(csv.res.status, 200, 'csv should be downloadable');
  assert.match(csv.res.headers.get('content-type') || '', /text\/csv/);
  assert.match(csv.text, /number,name,app_id/);

  const pause = await json('/api/ts/pause', { method: 'POST' });
  assert.equal(pause.body?.success, true, 'pause should be safe while idle');

  const removed = await json('/api/ts/profiles/' + encodeURIComponent(profileId), { method: 'DELETE' });
  assert.equal(removed.body?.success, true, 'profile should delete');
  for (const email of ['smoke-token-only@example.invalid', 'smoke-normalized-token@example.invalid', 'smoke-short-token@example.invalid']) {
    await json('/api/ts/accounts/' + encodeURIComponent(email), { method: 'DELETE' });
  }
  console.log('Botv3 smoke tests passed');
})().catch((error) => {
  console.error('Botv3 smoke tests failed:', error.message);
  process.exitCode = 1;
});
