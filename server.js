const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { scopedStore, currentUserId, userCtx, SYSTEM_UID } = require('./lib/userScope');
const { encrypt, tryDecrypt, isEncrypted } = require('./lib/crypto');
const { testProxy } = require('./lib/proxy');

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 5000);
const BUILD_STAMP = String(Date.now());

// Run an async fn inside a specific user's AsyncLocalStorage context.
// Equivalent to userCtx.run({ userId: uid }, fn) — used for background tasks
// that need to stay bound to the originating user after the request ends.
function withUser(uid, fn) {
  return userCtx.run({ userId: uid || SYSTEM_UID }, fn);
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.use(cookieParser());
app.use(express.json({ limit: '30mb' }));
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.includes('/stream'),
  message: { success: false, error: 'rate_limited' },
}));

app.use((req, res, next) => userCtx.run({ userId: SYSTEM_UID }, next));

const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#11151f"/><path fill="#7ce0c4" d="M44.6 19.5c-2.3-1-4.7-1.8-7.3-2.2-.3.6-.7 1.4-1 2-2.7-.4-5.4-.4-8 0-.3-.6-.7-1.4-1-2-2.5.5-5 1.3-7.3 2.3-4.6 6.9-5.8 13.6-5.2 20.2 3.1 2.3 6 3.7 8.9 4.6.7-1 1.4-2 1.9-3.1-1.1-.4-2.1-.9-3.1-1.5.3-.2.5-.4.8-.6 5.9 2.7 12.4 2.7 18.3 0 .3.2.5.4.8.6-1 .6-2 1.1-3.1 1.5.6 1.1 1.2 2.1 1.9 3.1 2.9-.9 5.8-2.3 8.9-4.6.7-7.7-1.2-14.3-5.2-20.2zM25.4 36.1c-1.8 0-3.2-1.6-3.2-3.6s1.4-3.6 3.2-3.6 3.3 1.6 3.2 3.6c0 2-1.4 3.6-3.2 3.6zm13.1 0c-1.8 0-3.2-1.6-3.2-3.6s1.4-3.6 3.2-3.6 3.3 1.6 3.2 3.6c0 2-1.4 3.6-3.2 3.6z"/></svg>`;
app.get('/discord.png', (req, res) => res.type('image/svg+xml').send(DEFAULT_AVATAR_SVG));
app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').send(DEFAULT_AVATAR_SVG));
app.get('/login', (req, res) => res.redirect('/'));
app.get('/signup', (req, res) => res.redirect('/'));
app.get('/api/build-stamp', (req, res) => res.json({ stamp: BUILD_STAMP }));

function serveIndex(res) {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    html = html.replace(
      /<script\b([^>]*?)\bsrc=(["'])(?!https?:|\/\/)([^"']+?)(?:\?[^"']*)?\2/g,
      (_m, attrs, q, src) => `<script${attrs}src=${q}${src}?v=${BUILD_STAMP}${q}`
    );
    html = html.replace(/<\/head>/i, `<script>window.__BUILD_STAMP__=${JSON.stringify(BUILD_STAMP)};</script></head>`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send('index.html load failed: ' + (e?.message || e));
  }
}
app.get('/', (req, res) => serveIndex(res));
app.get('/index.html', (req, res) => serveIndex(res));
app.use(express.static(path.join(__dirname), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

const botTokensStore = scopedStore('bot_tokens.json', []);
const dataStore = scopedStore('app_data.json', {});

// Bot tokens are secrets too. Keep the public API returning plaintext for the
// current UI, but encrypt them at rest and transparently migrate old plaintext
// records the next time a write occurs.
function decryptBotTokenRecord(record) {
  if (!record || typeof record !== 'object') return record;
  return { ...record, token: tryDecrypt(record.token) || record.token || '' };
}
function encryptBotTokenRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const token = String(record.token || '');
  return { ...record, token: token && !isEncrypted(token) ? encrypt(token) : token };
}
async function readBotTokens() {
  return (await botTokensStore.get() || []).map(decryptBotTokenRecord);
}
async function writeBotTokens(list) {
  await botTokensStore.set((Array.isArray(list) ? list : []).map(encryptBotTokenRecord));
}
function readData() { return dataStore.read(); }
function writeData(_d) { dataStore.touch(); }
function ensureData() {
  const d = dataStore.read();
  let changed = false;
  if (!Array.isArray(d.tsAccounts)) { d.tsAccounts = []; changed = true; }
  if (typeof d.tsLastNumber !== 'number') { d.tsLastNumber = 0; changed = true; }
  if (!d.tsPfp || typeof d.tsPfp !== 'object') {
    d.tsPfp = { avatar: null, banner: null, updatedAt: 0 };
    changed = true;
  }
  if (!d.tsCaptcha || typeof d.tsCaptcha !== 'object') { d.tsCaptcha = {}; changed = true; }
  if (typeof d.tsBulkTokenCounter !== 'number') { d.tsBulkTokenCounter = 0; changed = true; }
  if (!Array.isArray(d.tsProfiles)) { d.tsProfiles = []; changed = true; }
  if (typeof d.tsLastSession === 'undefined') { d.tsLastSession = null; changed = true; }
  if (changed) dataStore.touch();
  return d;
}
ensureData();

function ok(res, payload = {}) { res.json({ success: true, ...payload }); }
function fail(res, err) {
  const msg = err?.response?.data?.message || err?.message || String(err);
  res.json({ success: false, error: msg });
}
function dataUrlSizeBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return 0;
  const b64 = m[2];
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
}
function dataUrlMime(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;]+);/);
  return m ? m[1].toLowerCase() : null;
}
const ALLOWED_AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_BANNER_BYTES = 10 * 1024 * 1024;
const featureSSE = new Set();
function sseBroadcast(type, payload = {}) {
  const data = JSON.stringify({ type, ...payload });
  const eventUid = payload?._uid || null;
  for (const s of featureSSE) {
    // Each browser connection is bound to the user context captured when the
    // SSE request was opened. Never send another user's session snapshot or
    // reset-all progress to this connection.
    if (eventUid && s.uid && s.uid !== eventUid) continue;
    if (!s.types || s.types.includes(type)) {
      try { s.res.write(`data: ${data}\n\n`); } catch (_) {}
    }
  }
}

// ═══════════════════════════════════════════════
//  TRUE-STUDIO — TOTP-based account & bot automation engine
// ═══════════════════════════════════════════════
const ts = require('./lib/trueStudio');

  // Per-user session state (one active automation per user).
  // Key: currentUserId() · Value: ts.makeSession()
  const _tsSessions = new Map();
  function tsSession() {
    const uid = currentUserId();
    if (!_tsSessions.has(uid)) _tsSessions.set(uid, ts.makeSession());
    return _tsSessions.get(uid);
  }

  function tsAccountPauseUntil(s, email) {
    return Number(s?.pausedAccounts?.[String(email || '').toLowerCase()] || 0);
  }

  function setTsAccountCooldown(s, email, until, classification = 'cooldown', reason = '', extra = {}) {
    const key = String(email || '').toLowerCase();
    if (!key) return;
    if (!s.pausedAccounts || typeof s.pausedAccounts !== 'object') s.pausedAccounts = {};
    if (!s.pausedAccountMeta || typeof s.pausedAccountMeta !== 'object') s.pausedAccountMeta = {};
    s.pausedAccounts[key] = Number(until) || 0;
    s.pausedAccountMeta[key] = {
      classification: String(classification || 'cooldown'),
      reason: String(reason || '').slice(0, 240),
      ...extra,
    };
  }

  const TS_LOG_MAX = 250;
  function tsLog(level, msg, meta = null) {
    const s = tsSession();
    const entry = { ts: Date.now(), level, msg: String(msg).slice(0, 500) };
    if (meta && typeof meta === 'object') Object.assign(entry, meta);
    s.log.push(entry);
    if (s.log.length > TS_LOG_MAX) s.log.splice(0, s.log.length - TS_LOG_MAX);
    pushTsEvent('ts_log', { entry: s.log[s.log.length - 1] });
  }

  function tsSnapshot() {
    const s = tsSession();
    return {
      state: s.state,
      account: s.account,
      rules: s.rules,
      total: s.total,
      done: s.done,
      failed: s.failed,
      current: s.current,
      teamId: s.teamId,
      teamName: s.teamName,
      waitUntilTs: s.waitUntilTs,
      waitTotalMs: s.waitTotalMs,
      accountRateLimits: s.accountRateLimits || {},
      // Accounts temporarily paused by the switcher (RL, invalid token, or portal failure).
      // Keep the internal numeric timestamp private while exposing a stable object contract.
      pausedAccounts: Object.fromEntries(
        Object.entries(s.pausedAccounts || {})
          .filter(([, until]) => Number(until) > Date.now())
          .map(([email, until]) => [email, {
            waitUntilTs: Number(until),
            ...(s.pausedAccountMeta?.[email] || {}),
          }])
      ),
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      paused: s.pauseRequested === true,
      resumeAvailable: s.state === 'paused' || (s.state === 'cancelled' && !!ensureData().tsLastSession?.config),
      bots: (s.bots || []).map(b => ({ name: b.name, appId: b.appId, botUserId: b.botUserId, hasToken: !!b.token })),
      lastError: s.lastError,
      log: s.log.slice(-50),
      // Pending manual captcha challenge (if any). Frontend renders an hCaptcha
      // widget pointing at this sitekey and POSTs the token back via /api/ts/captcha-resolve.
      pendingCaptcha: s.pendingCaptcha
        ? { id: s.pendingCaptcha.id, sitekey: s.pendingCaptcha.sitekey, service: s.pendingCaptcha.service,
            context: s.pendingCaptcha.context, createdAt: s.pendingCaptcha.createdAt,
            // rqdata is request-specific data Discord includes in the captcha
            // challenge. The hCaptcha widget MUST receive it via render({ rqdata })
            // for the produced token to be accepted by Discord — otherwise Discord
            // returns { captcha_key: ["invalid-response"] } even on a valid solve.
            // (rqtoken stays server-side; we attach it to the retry request.)
            rqdata: s.pendingCaptcha.rqdata || null,
            attempts: s.pendingCaptcha.attempts || 0 }
        : null,
    };
  }

  function pushTsEvent(type, payload = {}) {
    // Tag each event with the user id so the SSE filter can route it.
    sseBroadcast(type, { ...payload, snapshot: tsSnapshot(), _uid: currentUserId() });
  }

  function clearPendingTsCaptcha(reason = 'Session stopped') {
    const s = tsSession();
    if (!s.pendingCaptcha) return false;
    const ch = s.pendingCaptcha;
    s.pendingCaptcha = null;
    if (ch.timer) clearTimeout(ch.timer);
    try { ch.reject(new Error(reason)); } catch (_) {}
    pushTsEvent('ts_captcha_cancelled', { id: ch.id, reason });
    return true;
  }

  // ── Account storage (per-user, encrypted at rest) ───────────────
  function tsAccountsRaw() {
    const d = ensureData();
    if (!Array.isArray(d.tsAccounts)) d.tsAccounts = [];
    return d.tsAccounts;
  }

  function tsAccountsPublic() {
    return tsAccountsRaw().map(a => ({
      email: a.email,
      hasPassword: !!a.password,
      hasTotp: !!a.totpSecret,
      hasDirectToken: !!a.directToken,
      addedAt: a.addedAt || 0,
      verify: a.verify || null,
    }));
  }

  function tsFindAccount(email) {
    const list = tsAccountsRaw();
    return list.find(a => a.email && a.email.toLowerCase() === String(email || '').toLowerCase()) || null;
  }

  function tsDecryptAccount(rec) {
    if (!rec) return null;
    return {
      email: rec.email,
      password: tryDecrypt(rec.password) || rec.password || '',
      totpSecret: tryDecrypt(rec.totpSecret) || rec.totpSecret || '',
      directToken: tryDecrypt(rec.directToken) || rec.directToken || '',
    };
  }



  function tsPfpSettings() {
    const d = ensureData();
    if (!d.tsPfp || typeof d.tsPfp !== 'object') d.tsPfp = { avatar: null, banner: null, updatedAt: 0 };
    return d.tsPfp;
  }

  function validateProfileImage(kind, value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value)) {
      throw new Error(`${kind} must be a PNG/JPEG/GIF/WebP data URL`);
    }
    const mime = dataUrlMime(value);
    const limit = kind === 'banner' ? MAX_BANNER_BYTES : MAX_AVATAR_BYTES;
    if (!ALLOWED_AVATAR_MIMES.includes(mime)) throw new Error(`${kind} mime is not supported`);
    if (dataUrlSizeBytes(value) > limit) throw new Error(`${kind} is too large (max ${Math.round(limit / 1024 / 1024)}MB)`);
    return value;
  }

  // ── Short-lived token cache (so repeated library refreshes don't hammer
  //    Discord with full email+TOTP logins). Key: lowercase email.
  const TS_TOKEN_TTL = 12 * 60 * 1000; // 12 minutes
  const _tsTokenCache = new Map();
  function tsCachedToken(email) {
    const e = _tsTokenCache.get(email);
    if (!e) return null;
    if (Date.now() > e.expires) { _tsTokenCache.delete(email); return null; }
    return { token: e.token, client: e.client || null };
  }
  function tsStoreToken(email, token, client) {
    _tsTokenCache.set(email, { token, client: client || null, expires: Date.now() + TS_TOKEN_TTL });
  }
  function tsClearToken(email) { _tsTokenCache.delete(email); }

  // Resolve a usable user-token + the warmed client (cookie jar, fingerprint).
  // Priority:
  //   1. In-memory cached token (still fresh) — fastest, no requests
  //   2. Direct token saved by user — skip login, warm session only
  //   3. Email + password login — full login flow with captcha handling
  async function tsGetToken(email) {
    const hit = tsCachedToken(email);
    if (hit) return hit;
    const acct = tsFindAccount(email);
    if (!acct) throw new Error('Account not found — save it first');
    const creds = tsDecryptAccount(acct);

    // ── Option A: Direct token (warm client, skip login) ──────────
    if (creds.directToken) {
      const client = ts.createClient();
      tsLog('info', 'استخدام التوكن المباشر — جاري تسخين الجلسة…');
      let warmed = false;
      try {
        await ts.warmUpClient(client);
        warmed = true;
      } catch (e) {
        tsLog('warn', 'تعذر تسخين الجلسة: ' + (e.message || e), { operation: 'warmup', confirmed: false });
      }
      if (!warmed) throw new Error('تعذر تجهيز جلسة التوكن المباشر');
      tsStoreToken(email, creds.directToken, client);
      tsLog('info', 'جلسة التوكن المباشر جاهزة بعد التحقق', { operation: 'warmup', confirmed: true });
      return { token: creds.directToken, client };
    }

    // ── Option B: Email + password login ─────────────────────────
    if (!creds.password) throw new Error('Saved account has no password and no direct token — re-save it');
    const client = ts.createClient();
    const netOpts = { solveCaptcha: buildSolveCaptcha(), client };
    const r = await ts.login({ email: creds.email, password: creds.password, totpSecret: creds.totpSecret, netOpts });
    tsStoreToken(email, r.token, client);
    return { token: r.token, client };
  }

  // ── Async sleep that respects cancel flag ──────────────────────
  async function waitIfPaused() {
    const s = tsSession();
    while (s.pauseRequested && !s.cancelRequested) {
      if (s.state !== 'paused') {
        s.state = 'paused';
        pushTsEvent('ts_progress');
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!s.cancelRequested && s.state === 'paused') {
      s.state = 'running';
      pushTsEvent('ts_progress');
    }
    return !s.cancelRequested;
  }

  async function tsSleep(ms) {
    const s = tsSession();
    const prevState = s.state;
    s.waitUntilTs = Date.now() + ms;
    s.waitTotalMs = ms;
    s.state = 'waiting';
    pushTsEvent('ts_progress');
    const tickEvery = 1000;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (s.cancelRequested) break;
      if (!(await waitIfPaused())) break;
      const left = Math.max(0, end - Date.now());
      await new Promise(r => setTimeout(r, Math.min(tickEvery, left)));
    }
    s.waitUntilTs = 0;
    s.waitTotalMs = 0;
    if (s.cancelRequested) return;
    s.state = (prevState === 'idle' || prevState === 'done' || prevState === 'cancelled' || prevState === 'error')
      ? prevState
      : 'running';
    pushTsEvent('ts_progress');
  }

  function makeTsRateLimiter(label, send = null, { minimumGapMs = 250, account = null } = {}) {
    let lastLogAt = 0;
    const accountKey = String(account || '').toLowerCase();
    return ts.createRateLimitGuard({
      label,
      minimumGapMs,
      safetyMs: 900,
      onWait: async ({ phase, reason, waitMs, route, bucket, scope }) => {
        const s = tsSession();
        if (reason === 'local_pacing') {
          if (phase === 'start' && waitMs >= 1000) {
            const now = Date.now();
            if (now - lastLogAt > 5000) {
              lastLogAt = now;
              tsLog('info', `${accountKey || 'account'} تنظيم طلبات داخلي: انتظار ${Math.ceil(waitMs / 1000)}s (${label})`);
            }
          }
          return;
        }
        if (phase === 'start' && waitMs > 0) {
          const prevState = s.state;
          s.waitUntilTs = Date.now() + waitMs;
          s.waitTotalMs = waitMs;
          s.state = 'waiting';
          if (!s.accountRateLimits || typeof s.accountRateLimits !== 'object') s.accountRateLimits = {};
          if (accountKey) {
            s.accountRateLimits[accountKey] = {
              label,
              reason,
              waitUntilTs: s.waitUntilTs,
              waitTotalMs: waitMs,
              route: route || null,
              bucket: bucket || null,
              scope: scope || null,
              prevState,
            };
          }
          const now = Date.now();
          if (now - lastLogAt > 2500) {
            lastLogAt = now;
            const seconds = Math.max(1, Math.ceil(waitMs / 1000));
            tsLog('warn', `${accountKey || 'account'} موقوف مؤقتاً بسبب rate limit: انتظار ${seconds}s قبل الطلب التالي (${label}/${reason})`);
          }
          try { send?.({ type: 'rate_limit_wait', label, account: accountKey || null, reason, waitMs, route, bucket, scope }); } catch (_) {}
          pushTsEvent('ts_progress');
        } else if (phase === 'end') {
          const prevState = accountKey && s.accountRateLimits?.[accountKey]?.prevState;
          if (!s.cancelRequested && s.state === 'waiting') {
            s.state = (prevState === 'idle' || prevState === 'done' || prevState === 'cancelled' || prevState === 'error')
              ? prevState
              : 'running';
          }
          s.waitUntilTs = 0;
          s.waitTotalMs = 0;
          if (accountKey && s.accountRateLimits) delete s.accountRateLimits[accountKey];
          try { send?.({ type: 'rate_limit_resume', label, account: accountKey || null, reason, route, bucket, scope }); } catch (_) {}
          pushTsEvent('ts_progress');
        }
      },
    });
  }

  function retryAfterMs(err, fallbackMs = 60_000) {
    const seconds = Number(err?.retryAfter ?? err?.retry_after ?? err?.data?.retry_after ?? err?.rateLimit?.retryAfter ?? err?.rateLimit?.resetAfter ?? 0);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 900;
    const ms = Number(err?.rateLimit?.waitMs || 0);
    return Number.isFinite(ms) && ms > 0 ? ms + 900 : fallbackMs;
  }

  function isRateLimitedError(err) {
    return err?.status === 429 || err?.code === 'RATE_LIMITED' || err?.code === 'CLOUDFLARE_BLOCK' || /rate[- ]?limit|429/i.test(err?.message || '');
  }

  // Detects Cloudflare IP blocks vs normal Discord 429s.
  // Source: Official Discord docs + discord.food + community research.
  //
  // A real Discord per-route 429 ALWAYS includes:
  //   X-RateLimit-Bucket header  → rateLimit.bucket !== null
  //   retry_after in JSON body   → rateLimit.retryAfter > 0
  //
  // A Cloudflare IP block has NEITHER — just a JSON {code:0} body or HTML
  // with a "blocked" message. Cloudflare blocks can last up to 24 hours so
  // waiting 60s on the same account is pointless → switch immediately.
  function isCloudflareBlock(err) {
    if (err?.code === 'CLOUDFLARE_BLOCK') return true; // set by _req fast-fail
    if (err?.status !== 429) return false;
    const msg = String(err?.message || err?.data?.message || '').toLowerCase();
    if (/blocked|error\s*1015|cloudflare|temporarily restricted/i.test(msg)) return true;
    const raw = typeof err?.data === 'string' ? err.data : '';
    if (/cloudflare|error\s*1015|attention required|temporarily restricted/i.test(raw.toLowerCase())) return true;
    // Discord's headers are optional; a missing bucket or code=0 is not enough
    // to call a 429 a Cloudflare block. Treat ambiguous 429s as rate limits so
    // we respect retry_after instead of switching or abandoning the account.
    return false;
  }

  async function withTsRateRetry(label, fn, { attempts = 2, send = null, minWaitMs = 0, idempotent = true } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        lastErr = e;
        if (!idempotent || !isRateLimitedError(e) || attempt >= attempts) throw e;
        const waitMs = Math.max(retryAfterMs(e), minWaitMs);
        const seconds = Math.ceil(waitMs / 1000);
        tsLog('warn', `${label}: rate limit — انتظار ${seconds}s ثم إعادة المحاولة (${attempt + 1}/${attempts})`);
        try { send?.({ type: 'retry', label, attempt: attempt + 1, retryMs: waitMs }); } catch (_) {}
        await tsSleep(waitMs);
      }
    }
    throw lastErr;
  }

  const _tsAccountQueues = new Map();
  function accountQueueKey(email) {
    return `${currentUserId()}|${String(email || '').trim().toLowerCase()}`;
  }

  function enqueueTsAccount(email, job, { label = 'Bot Studio task' } = {}) {
    const key = accountQueueKey(email);
    const hadQueue = _tsAccountQueues.has(key);
    const prev = _tsAccountQueues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      try {
        return await job();
      } finally {
        if (_tsAccountQueues.get(key) === run) _tsAccountQueues.delete(key);
      }
    });
    _tsAccountQueues.set(key, run);
    if (hadQueue) {
      try { tsLog('info', `${label}: تمت إضافته لطابور الحساب ${String(email || '').toLowerCase()}`); } catch (_) {}
    }
    return run;
  }

  function isTsAccountQueued(email) {
    return _tsAccountQueues.has(accountQueueKey(email));
  }

  // ── Bright Data settings (per-user, encrypted at rest) ──────────
  // Stores Customer ID, Zone name, Zone password, and protocol persistently
  // so users don't have to re-enter credentials every session.
  function tsBrightDataSettings() {
    const d = ensureData();
    if (!d.tsBrightData || typeof d.tsBrightData !== 'object') d.tsBrightData = {};
    return d.tsBrightData;
  }
  function tsBrightDataSettingsPublic() {
    const b = tsBrightDataSettings();
    return {
      enabled:      b.enabled === true,
      customerId:   b.customerId || '',
      zoneName:     b.zoneName || '',
      hasPassword:  !!b.zonePassword,
      protocol:     b.protocol || 'http',
      batchSize:    typeof b.batchSize === 'number' ? b.batchSize : 3,
      speed:        b.speed || 'veryfast',
    };
  }
  function tsBrightDataPassword() {
    const b = tsBrightDataSettings();
    if (!b.zonePassword) return '';
    return tryDecrypt(b.zonePassword) || b.zonePassword || '';
  }

  function parseBrightDataUsername(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const userPart = (() => {
      try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return decodeURIComponent(new URL(raw).username || '');
      } catch (_) {}
      return decodeURIComponent(raw.split(':')[0] || raw);
    })();
    const match = userPart.match(/^brd-customer-(.+?)-zone-(.+)$/i);
    if (!match) return null;
    const zoneWithFlags = match[2] || '';
    const flagMatch = zoneWithFlags.match(/^(.*?)(?:-(?:session|country|ip|asn|gip|route_err|direct)\b.*)?$/i);
    return {
      customerId: match[1],
      zoneName: (flagMatch?.[1] || zoneWithFlags).replace(/-$/, ''),
    };
  }

  function cleanBrightDataPart(value, kind) {
    let v = String(value || '').trim();
    if (!v) return '';
    try { v = decodeURIComponent(v); } catch (_) {}
    if (kind === 'customer') {
      const parsed = parseBrightDataUsername(v);
      if (parsed?.customerId) return parsed.customerId;
      return v.replace(/^brd-customer-/i, '').replace(/-zone-.+$/i, '');
    }
    const parsed = parseBrightDataUsername(v);
    if (parsed?.zoneName) return parsed.zoneName;
    return v.replace(/^zone-/i, '');
  }

  function resolveBrightDataConfig(input = {}, { useSavedPassword = false, useSavedFields = false } = {}) {
    const saved = tsBrightDataSettings();
    const src = input && typeof input === 'object' ? input : {};
    const enabled = src.enabled === true || (useSavedFields && saved.enabled === true);
    if (!enabled) return null;

    const parsedCustomer = parseBrightDataUsername(src.customerId);
    const parsedZone = parseBrightDataUsername(src.zoneName);
    const customerId = cleanBrightDataPart(
      parsedZone?.customerId || parsedCustomer?.customerId || src.customerId || (useSavedFields ? saved.customerId : ''),
      'customer',
    );
    const zoneName = cleanBrightDataPart(
      parsedZone?.zoneName || src.zoneName || parsedCustomer?.zoneName || (useSavedFields ? saved.zoneName : ''),
      'zone',
    );
    const zonePassword = String(src.zonePassword || (useSavedPassword ? tsBrightDataPassword() : '') || '');
    const protocol = src.protocol === 'socks5h' || (useSavedFields && saved.protocol === 'socks5h') ? 'socks5h' : 'http';

    if (!customerId || !zoneName || !zonePassword) return null;
    return { customerId, zoneName, zonePassword, protocol };
  }

  // ── Captcha settings (per-user, encrypted) ─────────────────────
  // Holds the user's hCaptcha solver service key (e.g. 2Captcha) plus the
  // manual-fallback toggle. When the API key is missing we always fall back
  // to manual solving so the project never stalls.
  function tsCaptchaSettings() {
    const d = ensureData();
    if (!d.tsCaptcha || typeof d.tsCaptcha !== 'object') d.tsCaptcha = {};
    return d.tsCaptcha;
  }
  function tsCaptchaSettingsPublic() {
    const c = tsCaptchaSettings();
    const provider = c.provider || '2captcha';
    const LABELS = { capsolver: 'CapSolver', capmonster: 'CapMonster', '2captcha': '2Captcha' };
    return {
      provider,
      hasApiKey: !!c.apiKey,
      manualFallback: c.manualFallback !== false,
      providerLabel: LABELS[provider] || '2Captcha',
    };
  }
  function tsCaptchaApiKey() {
    const c = tsCaptchaSettings();
    if (!c.apiKey) return '';
    return tryDecrypt(c.apiKey) || c.apiKey || '';
  }

  // CapSolver solver — Discord hCaptcha Enterprise
  //
  // الحقائق المؤكدة من أبحاث GitHub ومجتمع المطورين:
  //  • websiteURL يجب أن يكون https://discord.com وليس أي مسار API أو صفحة أخرى
  //  • userAgent مطلوب — يحسّن نتائج الحل للـ Enterprise
  //  • enterprisePayload.rqdata مطلوب لـ Discord — يجب وضعه هنا فقط
  //  • isEnterprise + isInvisible كلاهما حقول صالحة لـ HCaptchaTaskProxyLess
  //  • نجرب HCaptchaEnterpriseTaskProxyLess أولاً (الأفضل لـ Discord)
  //  • إذا رفضها الحساب (خطة غير مدعومة) نتراجع لـ HCaptchaTaskProxyLess + isEnterprise
  //  • نسجّل errorCode + errorDescription معاً لتسهيل التشخيص مستقبلاً
  //
  // Docs: https://docs.capsolver.com/en/guide/captcha/HCaptcha/
  async function solveWithCapSolver({ apiKey, sitekey, pageUrl, rqdata, rqtoken }) {
    const axios = require('axios');

    // websiteURL يجب أن يكون صفحة Discord حقيقية — لا مسار API ولا صفحة المطورين.
    // CapSolver يتحقق من أن الـ captcha موجود فعلاً على هذه الصفحة.
    const DISCORD_PAGE_URL = 'https://discord.com';
    const browserPageUrl = (pageUrl && !pageUrl.includes('/api/') && pageUrl.startsWith('https://discord.com'))
      ? pageUrl
      : DISCORD_PAGE_URL;

    const USER_AGENT =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36';

    // دالة مساعدة لتحويل أخطاء CapSolver لرسائل عربية واضحة
    function capsolvErr(data) {
      const code = data.errorCode || '';
      const desc = data.errorDescription || '';
      const detail = [code, desc].filter(Boolean).join(' — ');
      if (code === 'ERROR_ZERO_BALANCE')        return 'CapSolver: رصيد صفر — يرجى شحن الحساب على capsolver.com';
      if (code === 'ERROR_KEY_DOES_NOT_EXIST')  return 'CapSolver: مفتاح API غير موجود';
      if (code === 'ERROR_WRONG_USER_KEY')      return 'CapSolver: مفتاح API غير صالح';
      if (code === 'ERROR_BLOCKED_USER')        return 'CapSolver: الحساب موقوف — تواصل مع دعم CapSolver';
      return 'CapSolver خطأ: ' + (detail || JSON.stringify(data));
    }

    // إرسال مهمة بنوع محدد — يُرجع taskId أو يرمي خطأ
    async function trySubmit(type) {
      const task = {
        type,
        websiteURL:   browserPageUrl,
        websiteKey:   sitekey,
        isEnterprise: true,
        isInvisible:  false,
        userAgent:    USER_AGENT,
      };
      // rqdata يذهب داخل enterprisePayload فقط — خارجه يسبب ERROR_INVALID_TASK_DATA
      if (rqdata) task.enterprisePayload = { rqdata };

      const res = await axios.post('https://api.capsolver.com/createTask',
        { clientKey: apiKey, task },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20_000, validateStatus: () => true }
      );

      if (!res.data) throw new Error('CapSolver: ردّ فارغ (HTTP ' + res.status + ')');
      if (res.data.errorId) {
        const code = res.data.errorCode || '';
        const desc = res.data.errorDescription || '';
        // هذا النوع غير مدعوم على الخطة الحالية — جرّب البديل
        if (desc.includes('not supported') || desc.includes('invalid task') || code === 'ERROR_INVALID_TASK_DATA') {
          const e = new Error('[unsupported_type] ' + type + ': ' + desc);
          e.unsupportedType = true;
          throw e;
        }
        throw new Error(capsolvErr(res.data));
      }
      if (!res.data.taskId) throw new Error('CapSolver: لم يُرجع taskId');
      return res.data.taskId;
    }

    // الترتيب: الأنواع المدعومة على جميع الخطط أولاً، غير المدعومة آخراً.
    // HCaptchaTaskProxyLess → يعمل على كل الخطط
    // HCaptchaEnterpriseTaskProxyLess → يحتاج خطة مدفوعة، يُجرَّب آخراً فقط
    const TYPES_TO_TRY = [
      'HCaptchaTaskProxyLess',
      'HCaptchaEnterpriseTaskProxyLess',
    ];

    let taskId = null;
    for (const type of TYPES_TO_TRY) {
      try {
        taskId = await trySubmit(type);
        tsLog('info', `CapSolver: تم إرسال المهمة بنوع "${type}" — taskId: ${taskId}`);
        break;
      } catch (e) {
        if (e.unsupportedType && type !== TYPES_TO_TRY[TYPES_TO_TRY.length - 1]) {
          tsLog('warn', `CapSolver: "${type}" غير مدعوم — جاري تجربة "${TYPES_TO_TRY[TYPES_TO_TRY.indexOf(type) + 1]}"…`);
          continue;
        }
        throw e;
      }
    }
    if (!taskId) throw new Error('CapSolver: فشل إنشاء المهمة بكل الأنواع المتاحة');

    // استطلاع النتيجة — انتظار 5 ث أولاً ثم كل 4 ث (hCaptcha يُحلّ عادةً خلال 8-20 ث)
    const startedAt  = Date.now();
    const TIMEOUT_MS = 180_000;
    await new Promise(r => setTimeout(r, 5_000));

    while (Date.now() - startedAt < TIMEOUT_MS) {
      const r = await axios.post('https://api.capsolver.com/getTaskResult',
        { clientKey: apiKey, taskId },
        { timeout: 15_000, validateStatus: () => true }
      );
      const body = r.data || {};
      if (body.errorId) throw new Error(capsolvErr(body));
      if (body.status === 'ready' && body.solution?.gRecaptchaResponse) {
        return String(body.solution.gRecaptchaResponse);
      }
      await new Promise(r => setTimeout(r, 4_000));
    }
    throw new Error('CapSolver: انتهت مهلة الانتظار (180 ث) بدون حل');
  }

  // 2Captcha solver — submits Discord's hCaptcha Enterprise challenge and polls for a token.
  //
  // Key facts about Discord hCaptcha (sourced from 2captcha docs + community research):
  //  • Discord always uses hCaptcha Enterprise → enterprise=1 is mandatory
  //  • Discord uses invisible mode → invisible=1 is mandatory
  //  • captcha_rqdata from Discord's 400 response MUST be forwarded as "data" param
  //  • pageurl must be a real browser-facing Discord URL, never an API endpoint path
  //  • userAgent should be a real Chrome UA — affects solve quality on Enterprise challenges
  //  • Initial poll wait: 5 s (hCaptcha), NOT 20 s (that is for reCAPTCHA only)
  //  • Poll interval: 5 s minimum per 2captcha docs
  //  • ERROR_CAPTCHA_UNSOLVABLE → free retry (not charged), retry up to 2 times
  //  • ERROR_NO_SLOT_AVAILABLE → worker queue full, wait 5 s and retry submission
  //  • ERROR_ZERO_BALANCE → surface a clear message so the user can top up
  //  • CAPCHA_NOT_READY → normal polling status, NOT an error — keep polling
  //
  // Docs: https://2captcha.com/2captcha-api#solving_hcaptcha
  //       https://2captcha.com/api-docs/error-codes
  async function solveWith2Captcha({ apiKey, sitekey, pageUrl, rqdata }) {
    const axios = require('axios');

    // pageurl must be a browser page, never a Discord REST API path.
    const DISCORD_BROWSER_URL = 'https://discord.com/login';
    const browserPageUrl = (pageUrl && !pageUrl.includes('/api/'))
      ? pageUrl
      : DISCORD_BROWSER_URL;

    // A realistic Chrome UA improves solve quality for Enterprise invisible challenges.
    const USER_AGENT =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36';

    // Fatal error codes — no point retrying the same submission.
    const FATAL_CODES = new Set([
      'ERROR_WRONG_USER_KEY',
      'ERROR_KEY_DOES_NOT_EXIST',
      'ERROR_ZERO_BALANCE',
      'ERROR_IP_NOT_ALLOWED',
      'IP_BANNED',
      'ERROR_PAGEURL',
      'ERROR_WRONG_ID_FORMAT',
      'ERROR_WRONG_CAPTCHA_ID',
    ]);

    // Human-readable Arabic messages for common fatal errors.
    const FRIENDLY = {
      ERROR_ZERO_BALANCE:       'رصيد 2Captcha صفر — يرجى شحن الحساب على 2captcha.com',
      ERROR_WRONG_USER_KEY:     'مفتاح 2Captcha غير صالح (تحقق من أنه 32 حرفاً بالضبط)',
      ERROR_KEY_DOES_NOT_EXIST: 'مفتاح 2Captcha غير موجود — تحقق من لوحة التحكم',
      ERROR_IP_NOT_ALLOWED:     'عنوان IP هذا غير مسموح به في إعدادات 2Captcha',
      IP_BANNED:                'تم حظر IP من 2Captcha مؤقتاً — انتظر بضع دقائق',
    };

    // ── Step 1: Submit the task (retry on ERROR_NO_SLOT_AVAILABLE) ────────
    async function submitTask() {
      const MAX_SLOT_RETRIES = 3;
      for (let attempt = 0; attempt < MAX_SLOT_RETRIES; attempt++) {
        const form = new URLSearchParams();
        form.append('key',        apiKey);
        form.append('method',     'hcaptcha');
        form.append('sitekey',    sitekey);
        form.append('pageurl',    browserPageUrl);
        form.append('enterprise', '1');   // Discord always uses hCaptcha Enterprise
        form.append('invisible',  '1');   // Discord uses invisible mode
        form.append('userAgent',  USER_AGENT);
        form.append('json',       '1');
        // rqdata is Discord's per-request challenge token — required when present.
        if (rqdata) form.append('data', rqdata);

        const res = await axios.post('https://2captcha.com/in.php', form.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 20_000,
          validateStatus: () => true,
        });

        if (!res.data) throw new Error('2captcha: ردّ فارغ عند الإرسال (HTTP ' + res.status + ')');

        const body = res.data;
        // Slot unavailable — worker queue full, wait and retry submission.
        if (body.request === 'ERROR_NO_SLOT_AVAILABLE') {
          if (attempt < MAX_SLOT_RETRIES - 1) {
            tsLog('warn', '2Captcha: قائمة الانتظار ممتلئة، إعادة المحاولة خلال 5 ثوانٍ…');
            await new Promise(r => setTimeout(r, 5_000));
            continue;
          }
          throw new Error('2Captcha: قائمة الانتظار ممتلئة بشكل متكرر — حاول لاحقاً');
        }

        if (Number(body.status) !== 1) {
          const code = body.request || JSON.stringify(body);
          throw new Error(FRIENDLY[code] || ('2captcha رفض الإرسال: ' + code));
        }

        return String(body.request); // taskId
      }
    }

    // ── Step 2: Poll for the result ───────────────────────────────────────
    async function pollResult(captchaId) {
      const POLL_INTERVAL_MS = 5_000;  // 5 s min per 2captcha docs
      const TIMEOUT_MS       = 160_000; // 160 s (hCaptcha typical: 15-90 s)
      const startedAt        = Date.now();

      // Initial wait: 5 s for hCaptcha (2captcha docs; 20 s is only for reCAPTCHA).
      await new Promise(r => setTimeout(r, 5_000));

      while (Date.now() - startedAt < TIMEOUT_MS) {
        const res = await axios.get('https://2captcha.com/res.php', {
          params: { key: apiKey, action: 'get', id: captchaId, json: 1 },
          timeout: 15_000,
          validateStatus: () => true,
        });

        const body = res.data || {};
        const req  = body.request || '';

        // Solved successfully.
        if (Number(body.status) === 1 && req) return String(req);

        // Still solving — keep polling.
        if (req === 'CAPCHA_NOT_READY') {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        // Fatal errors — stop immediately with a clear message.
        if (FATAL_CODES.has(req)) {
          throw new Error(FRIENDLY[req] || ('2captcha خطأ فادح: ' + req));
        }

        // ERROR_CAPTCHA_UNSOLVABLE — not charged; signal caller to retry.
        if (req === 'ERROR_CAPTCHA_UNSOLVABLE') {
          const err = new Error('2captcha: العمال فشلوا في الحل (لن يتم خصم رصيد) — إعادة المحاولة');
          err.unsolvable = true;
          throw err;
        }

        // Any other unexpected error code.
        if (req) throw new Error('2captcha خطأ غير متوقع: ' + req);

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      throw new Error('2captcha: انتهت مهلة الانتظار (160 ثانية) بدون حل');
    }

    // ── Orchestrate with retry on ERROR_CAPTCHA_UNSOLVABLE (free re-solve) ─
    const MAX_UNSOLVABLE_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_UNSOLVABLE_RETRIES; attempt++) {
      let captchaId;
      try {
        captchaId = await submitTask();
      } catch (e) {
        throw e; // submission errors are not retryable here
      }

      try {
        return await pollResult(captchaId);
      } catch (e) {
        if (e.unsolvable && attempt < MAX_UNSOLVABLE_RETRIES) {
          tsLog('warn', `2Captcha: فشل الحل (محاولة ${attempt + 1}/${MAX_UNSOLVABLE_RETRIES}) — إعادة إرسال المهمة…`);
          continue;
        }
        throw e;
      }
    }

    throw new Error('2captcha: استنفدت جميع محاولات إعادة الحل');
  }

  // CapMonster Cloud solver — نفس API تماماً كـ CapSolver لكن بدون حظر Discord.
  // CapMonster لا يطبق قيود سياسة الاستخدام على Discord hCaptcha.
  // Docs: https://docs.capmonster.cloud/docs/captchas/h-captcha
  async function solveWithCapMonster({ apiKey, sitekey, pageUrl, rqdata }) {
    const axios = require('axios');
    const BASE   = 'https://api.capmonster.cloud';

    const DISCORD_PAGE_URL = 'https://discord.com';
    const browserPageUrl   = (pageUrl && !pageUrl.includes('/api/') && pageUrl.startsWith('https://discord.com'))
      ? pageUrl : DISCORD_PAGE_URL;

    const USER_AGENT =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // إرسال المهمة
    const task = {
      type:        'HCaptchaTaskProxyless',  // CapMonster يستخدم lowercase 'l'
      websiteURL:  browserPageUrl,
      websiteKey:  sitekey,
      isInvisible: false,
      userAgent:   USER_AGENT,
    };
    if (rqdata) task.enterprisePayload = { rqdata };

    const create = await axios.post(`${BASE}/createTask`,
      { clientKey: apiKey, task },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20_000, validateStatus: () => true }
    );

    if (!create.data) throw new Error('CapMonster: ردّ فارغ (HTTP ' + create.status + ')');
    if (create.data.errorId) {
      const code = create.data.errorCode || '';
      const desc = create.data.errorDescription || '';
      if (code === 'ERROR_ZERO_BALANCE' || desc.includes('zero balance') || desc.includes('balance'))
        throw new Error('CapMonster: رصيد صفر — يرجى شحن الحساب على capmonster.cloud');
      if (code === 'ERROR_KEY_DOES_NOT_EXIST' || desc.includes('key'))
        throw new Error('CapMonster: مفتاح API غير صالح أو غير موجود');
      throw new Error('CapMonster خطأ: ' + ([code, desc].filter(Boolean).join(' — ') || JSON.stringify(create.data)));
    }

    const taskId = create.data.taskId;
    if (!taskId) throw new Error('CapMonster: لم يُرجع taskId');

    // استطلاع النتيجة — انتظار 5 ث ثم كل 4 ث
    const startedAt  = Date.now();
    const TIMEOUT_MS = 180_000;
    await new Promise(r => setTimeout(r, 5_000));

    while (Date.now() - startedAt < TIMEOUT_MS) {
      const r = await axios.post(`${BASE}/getTaskResult`,
        { clientKey: apiKey, taskId },
        { timeout: 15_000, validateStatus: () => true }
      );
      const body = r.data || {};
      if (body.errorId) throw new Error('CapMonster poll error: ' + (body.errorCode || body.errorDescription));
      if (body.status === 'ready' && body.solution?.gRecaptchaResponse) {
        return String(body.solution.gRecaptchaResponse);
      }
      await new Promise(r => setTimeout(r, 4_000));
    }
    throw new Error('CapMonster: انتهت مهلة الانتظار (180 ث) بدون حل');
  }

  // Manual solver — exposes the challenge over SSE, awaits the user clicking
  // the hCaptcha widget in the UI and POSTing the token to /api/ts/captcha-resolve.
  // Times out after MANUAL_TIMEOUT_MS so a forgotten challenge cannot wedge the session.
  const MANUAL_CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;
  function solveCaptchaManual({ sitekey, service, rqdata, rqtoken, url, context }) {
    const s = tsSession();
    return new Promise((resolve, reject) => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const challenge = {
        id, sitekey, service: service || 'hcaptcha',
        rqdata, rqtoken, url, context,
        createdAt: Date.now(),
        attempts: (s.pendingCaptcha?.attempts || 0) + 1,
        resolve, reject,
        timer: null,
      };
      challenge.timer = setTimeout(() => {
        if (s.pendingCaptcha && s.pendingCaptcha.id === id) {
          s.pendingCaptcha = null;
          tsLog('error', 'انتهت مهلة الكابتشا اليدوية بدون حل');
          pushTsEvent('ts_captcha_timeout', { id });
          pushTsEvent('ts_progress');
          reject(new Error('Manual captcha timed out (5 min)'));
        }
      }, MANUAL_CAPTCHA_TIMEOUT_MS);
      s.pendingCaptcha = challenge;
      // Diagnostic: surface whether Discord actually sent rqdata so the user
      // can tell from the UI log alone if the "invalid-response" failure mode
      // is a missing-rqdata problem vs a stale-cached frontend problem.
      const _rqLen = rqdata ? String(rqdata).length : 0;
      tsLog('warn', `مطلوب حل كابتشا يدوياً — افتح النافذة المنبثقة (rqdata: ${_rqLen ? `موجود ${_rqLen} حرف` : 'غير موجود'})`);
      pushTsEvent('ts_captcha', { challenge: {
        id, sitekey, service: challenge.service, context, attempts: challenge.attempts,
        // Forward rqdata so the modal can pass it to hcaptcha.render().
        // Without this the produced token is generic and Discord rejects it.
        rqdata: rqdata || null,
      } });
      pushTsEvent('ts_progress');
    });
  }

  // The unified solver passed into every Discord call. Tries the configured
  // provider first (2Captcha or CapSolver), then falls back to manual unless
  // the user explicitly disabled the manual fallback in settings.
  function buildSolveCaptcha() {
    return async function solveCaptcha({ sitekey, service, rqdata, rqtoken, url, context }) {
      const settings = tsCaptchaSettings();
      const apiKey   = tsCaptchaApiKey();
      const provider = settings.provider || '2captcha';

      if (apiKey && provider === 'capsolver') {
        try {
          tsLog('info', 'محاولة حل الكابتشا تلقائياً عبر CapSolver…');
          const token = await solveWithCapSolver({ apiKey, sitekey, pageUrl: url, rqdata, rqtoken });
          if (token) { tsLog('info', 'استلمنا توكن من CapSolver — بانتظار تأكيد Discord', { operation: 'captcha_solve', confirmed: false, stage: 'solver_response' }); return token; }
        } catch (e) { tsLog('warn', 'CapSolver فشل: ' + (e.message || e)); }
      }

      if (apiKey && provider === 'capmonster') {
        try {
          tsLog('info', 'محاولة حل الكابتشا تلقائياً عبر CapMonster…');
          const token = await solveWithCapMonster({ apiKey, sitekey, pageUrl: url, rqdata });
          if (token) { tsLog('info', 'استلمنا توكن من CapMonster — بانتظار تأكيد Discord', { operation: 'captcha_solve', confirmed: false, stage: 'solver_response' }); return token; }
        } catch (e) { tsLog('warn', 'CapMonster فشل: ' + (e.message || e)); }
      }

      if (apiKey && provider === '2captcha') {
        try {
          tsLog('info', 'محاولة حل الكابتشا تلقائياً عبر 2Captcha…');
          const token = await solveWith2Captcha({ apiKey, sitekey, pageUrl: url, rqdata });
          if (token) { tsLog('info', 'استلمنا توكن من 2Captcha — بانتظار تأكيد Discord', { operation: 'captcha_solve', confirmed: false, stage: 'solver_response' }); return token; }
        } catch (e) { tsLog('warn', '2Captcha فشل: ' + (e.message || e)); }
      }

      if (apiKey || settings.manualFallback === false) {
        throw new Error(
          apiKey
            ? 'الحل التلقائي فشل ولا يوجد رجوع يدوي عند وجود API key — تحقق من رصيدك أو صحة المفتاح'
            : 'No automatic solver succeeded and manual fallback is disabled'
        );
      }
      return await solveCaptchaManual({ sitekey, service, rqdata, rqtoken, url, context });
    };
  }

  // ─── Endpoints ─────────────────────────────────────────────────

  // Captcha settings — view / update the hCaptcha solver configuration.
  app.get('/api/ts/captcha-settings', (req, res) => {
    ok(res, { settings: tsCaptchaSettingsPublic() });
  });
  app.post('/api/ts/captcha-settings', (req, res) => {
    const { provider, apiKey, manualFallback, clearKey } = req.body || {};
    const d = ensureData();
    if (!d.tsCaptcha || typeof d.tsCaptcha !== 'object') d.tsCaptcha = {};
    if (typeof provider === 'string' && provider) {
      const allowed = ['2captcha', 'capsolver', 'capmonster'];
      if (!allowed.includes(provider)) return fail(res, new Error('Unsupported provider'));
      d.tsCaptcha.provider = provider;
    }
    if (clearKey === true) {
      d.tsCaptcha.apiKey = '';
    } else if (typeof apiKey === 'string' && apiKey.trim()) {
      const trimmed = apiKey.trim();
      if (trimmed.length < 10 || trimmed.length > 256) return fail(res, new Error('Invalid API key length'));
      d.tsCaptcha.apiKey = encrypt(trimmed);
    }
    if (typeof manualFallback === 'boolean') d.tsCaptcha.manualFallback = manualFallback;
    writeData(d);
    ok(res, { settings: tsCaptchaSettingsPublic() });
  });

  // Bright Data settings — view / save persistent proxy credentials
  app.get('/api/ts/brightdata-settings', (req, res) => {
    ok(res, { settings: tsBrightDataSettingsPublic() });
  });
  app.post('/api/ts/brightdata-settings', (req, res) => {
    const { enabled, customerId, zoneName, zonePassword, clearPassword, protocol, batchSize, speed } = req.body || {};
    const d = ensureData();
    if (!d.tsBrightData || typeof d.tsBrightData !== 'object') d.tsBrightData = {};
    if (typeof enabled === 'boolean') d.tsBrightData.enabled = enabled;
    const parsedCustomer = typeof customerId === 'string' ? parseBrightDataUsername(customerId) : null;
    const parsedZone = typeof zoneName === 'string' ? parseBrightDataUsername(zoneName) : null;
    if (typeof customerId === 'string') {
      d.tsBrightData.customerId = cleanBrightDataPart(parsedCustomer?.customerId || customerId, 'customer');
      if (parsedCustomer?.zoneName && typeof zoneName !== 'string') d.tsBrightData.zoneName = parsedCustomer.zoneName;
    }
    if (typeof zoneName === 'string') {
      if (parsedZone?.customerId && !d.tsBrightData.customerId) d.tsBrightData.customerId = parsedZone.customerId;
      d.tsBrightData.zoneName = cleanBrightDataPart(parsedZone?.zoneName || zoneName, 'zone');
    }
    if (clearPassword === true) {
      d.tsBrightData.zonePassword = '';
    } else if (typeof zonePassword === 'string' && zonePassword) {
      d.tsBrightData.zonePassword = encrypt(zonePassword);
    }
    if (typeof protocol === 'string' && (protocol === 'http' || protocol === 'socks5h')) {
      d.tsBrightData.protocol = protocol;
    }
    if (typeof batchSize === 'number' && batchSize >= 1 && batchSize <= 5) {
      d.tsBrightData.batchSize = batchSize;
    }
    if (typeof speed === 'string') d.tsBrightData.speed = speed;
    writeData(d);
    ok(res, { settings: tsBrightDataSettingsPublic() });
  });

  // Captcha key verification — checks balance and validity for the saved key.
  app.get('/api/ts/captcha-verify', async (req, res) => {
    const apiKey = tsCaptchaApiKey();
    const settings = tsCaptchaSettings();
    const provider = settings.provider || '2captcha';
    if (!apiKey) return fail(res, new Error('لا يوجد API key محفوظ'));
    try {
      if (provider === 'capsolver') {
        const r = await axios.post('https://api.capsolver.com/getBalance',
          { clientKey: apiKey }, { timeout: 12000, validateStatus: () => true });
        if (r.data && r.data.errorId === 0) {
          return ok(res, { ok: true, balance: r.data.balance, currency: 'USD', provider: 'CapSolver' });
        }
        return ok(res, { ok: false, error: r.data?.errorDescription || 'مفتاح غير صالح', provider: 'CapSolver' });
      } else if (provider === 'capmonster') {
        const r = await axios.post('https://api.capmonster.cloud/getBalance',
          { clientKey: apiKey }, { timeout: 12000, validateStatus: () => true });
        if (r.data && r.data.errorId === 0) {
          return ok(res, { ok: true, balance: r.data.balance, currency: 'USD', provider: 'CapMonster' });
        }
        const errDesc = r.data?.errorDescription || r.data?.errorCode || 'مفتاح غير صالح';
        return ok(res, { ok: false, error: errDesc, provider: 'CapMonster' });
      } else {
        const r = await axios.get(
          `https://2captcha.com/res.php?action=getbalance&key=${encodeURIComponent(apiKey)}`,
          { timeout: 12000 });
        const text = String(r.data || '').trim();
        if (!isNaN(parseFloat(text))) {
          return ok(res, { ok: true, balance: parseFloat(text), currency: 'USD', provider: '2Captcha' });
        }
        return ok(res, { ok: false, error: text, provider: '2Captcha' });
      }
    } catch (e) {
      return fail(res, e);
    }
  });

  // Manual captcha resolution — frontend posts the hCaptcha token here after
  // the user solved the widget. We resolve the pending Promise so the request
  // chain inside trueStudio.js can continue.
  app.post('/api/ts/captcha-resolve/:id', (req, res) => {
    const s = tsSession();
    const id = String(req.params.id || '');
    const token = String((req.body && req.body.token) || '');
    if (!s.pendingCaptcha || s.pendingCaptcha.id !== id) {
      return fail(res, new Error('No matching pending captcha'));
    }
    if (!token || token.length < 10) return fail(res, new Error('Invalid captcha token'));
    const ch = s.pendingCaptcha;
    s.pendingCaptcha = null;
    if (ch.timer) clearTimeout(ch.timer);
    // Diagnostic: real hCaptcha tokens are ~700-2000 chars and start with "P1_"
    // or "E0_". A token shorter than ~200 chars or one that doesn't start with
    // those prefixes is almost certainly NOT a valid hCaptcha solve and will be
    // rejected by Discord as "invalid-response" — surface that in the UI log so
    // the user knows immediately whether the widget actually produced a token.
    const _tokPrefix = token.slice(0, 4);
    const _looksReal = token.length >= 200 && /^(P[01]_|E[01]_)/.test(token);
    if (!_looksReal) {
      const reason = `توكن الكابتشا غير صالح ظاهرياً (الطول ${token.length}، البداية ${_tokPrefix || 'فارغة'})`;
      tsLog('error', reason, { operation: 'captcha_resolve', confirmed: false, stage: 'validate_token' });
      try { ch.reject(new Error(reason)); } catch {}
      pushTsEvent('ts_captcha_rejected', { id, reason });
      pushTsEvent('ts_progress');
      return fail(res, new Error(reason));
    }
    tsLog('info', `تم قبول توكن الكابتشا مبدئياً للفحص من Discord (الطول: ${token.length})`, {
      operation: 'captcha_resolve', confirmed: false, stage: 'validate_token',
    });
    try { ch.resolve(token); } catch {}
    pushTsEvent('ts_captcha_resolved', { id });
    pushTsEvent('ts_progress');
    ok(res, { snapshot: tsSnapshot(), accepted: true });
  });

  // Cancel an outstanding manual captcha (user closed the popup).
  app.post('/api/ts/captcha-cancel/:id', (req, res) => {
    const s = tsSession();
    const id = String(req.params.id || '');
    if (!s.pendingCaptcha || s.pendingCaptcha.id !== id) {
      return ok(res, { snapshot: tsSnapshot() });
    }
    clearPendingTsCaptcha('Captcha cancelled by user');
    tsLog('warn', 'تم إلغاء الكابتشا — الجلسة ستفشل');
    pushTsEvent('ts_progress');
    ok(res, { snapshot: tsSnapshot() });
  });

  app.get('/api/ts/accounts', (req, res) => {
    ok(res, { accounts: tsAccountsPublic() });
  });

  app.post('/api/ts/accounts', (req, res) => {
    const { email, password, totpSecret, directToken } = req.body || {};
    if (!email || typeof email !== 'string') return fail(res, new Error('Email is required'));
    const cleanEmail = email.trim().toLowerCase();
    if (cleanEmail.length > 254 || !cleanEmail.includes('@')) return fail(res, new Error('Invalid email'));
    if (password && typeof password !== 'string') return fail(res, new Error('Password must be a string'));
    if (totpSecret && !ts.isValidTotpSecret(totpSecret)) return fail(res, new Error('Invalid 2FA secret (must be a base32 string)'));
    if (directToken && typeof directToken !== 'string') return fail(res, new Error('Token must be a string'));

    const d = ensureData();
    if (!Array.isArray(d.tsAccounts)) d.tsAccounts = [];
    let rec = tsFindAccount(cleanEmail);
    if (!rec) {
      rec = { email: cleanEmail, password: '', totpSecret: '', directToken: '', addedAt: Date.now() };
      d.tsAccounts.push(rec);
    }
    if (typeof password === 'string' && password) rec.password = encrypt(password);
    else if (password === '') rec.password = '';
    if (typeof totpSecret === 'string' && totpSecret) rec.totpSecret = encrypt(totpSecret.replace(/\s+/g, ''));
    else if (totpSecret === '') rec.totpSecret = '';
    if (typeof directToken === 'string' && directToken.trim()) rec.directToken = encrypt(directToken.trim());
    else if (directToken === '') rec.directToken = '';
    writeData(d);
    ok(res, { account: { email: rec.email, hasPassword: !!rec.password, hasTotp: !!rec.totpSecret, hasDirectToken: !!rec.directToken, addedAt: rec.addedAt } });
  });

  // ── Bulk token import — one token per line, auto-numbered tok-N@local ──
  app.post('/api/ts/accounts/bulk-tokens', (req, res) => {
    const { tokens } = req.body || {};
    if (!Array.isArray(tokens) || tokens.length === 0)
      return fail(res, new Error('لا توجد توكنات'));
    const valid = tokens.map(tk => (typeof tk === 'string' ? tk.trim() : '')).filter(tk => tk.length > 10);
    if (valid.length === 0)
      return fail(res, new Error('لا توجد توكنات صالحة'));
    const d = ensureData();
    if (!Array.isArray(d.tsAccounts)) d.tsAccounts = [];
    if (typeof d.tsBulkTokenCounter !== 'number') d.tsBulkTokenCounter = 0;
    const added = [];
    for (const rawToken of valid) {
      d.tsBulkTokenCounter += 1;
      const email = `tok-${d.tsBulkTokenCounter}@local`;
      let rec = tsFindAccount(email);
      if (!rec) {
        rec = { email, password: '', totpSecret: '', directToken: '', addedAt: Date.now() };
        d.tsAccounts.push(rec);
      }
      rec.directToken = encrypt(rawToken);
      rec.addedAt = Date.now();
      added.push({ email, num: d.tsBulkTokenCounter });
    }
    writeData(d);
    ok(res, { added, count: added.length });
  });

  // ── Delete all numbered tok-N@local accounts ──
  app.delete('/api/ts/accounts/bulk-tokens', (req, res) => {
    const d = ensureData();
    const before = (d.tsAccounts || []).length;
    d.tsAccounts = (d.tsAccounts || []).filter(a => !/^tok-\d+@local$/.test((a.email || '').toLowerCase()));
    d.tsBulkTokenCounter = 0;
    const removed = before - (d.tsAccounts || []).length;
    writeData(d);
    ok(res, { removed });
  });

  app.delete('/api/ts/accounts/:email', (req, res) => {
    const target = String(req.params.email || '').toLowerCase();
    const d = ensureData();
    const before = (d.tsAccounts || []).length;
    d.tsAccounts = (d.tsAccounts || []).filter(a => (a.email || '').toLowerCase() !== target);
    if (d.tsAccounts.length === before) return fail(res, new Error('Account not found'));
    writeData(d);
    ok(res, { removed: target });
  });

  app.get('/api/ts/state', (req, res) => {
    ok(res, { snapshot: tsSnapshot(), accounts: tsAccountsPublic() });
  });


  app.get('/api/ts/pfp', (req, res) => {
    try {
      const p = tsPfpSettings();
      ok(res, { pfp: { avatar: p.avatar || null, banner: p.banner || null, updatedAt: p.updatedAt || 0 } });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/ts/pfp', (req, res) => {
    try {
      const avatar = validateProfileImage('avatar', req.body?.avatar || null);
      const banner = validateProfileImage('banner', req.body?.banner || null);
      const p = tsPfpSettings();
      p.avatar = avatar;
      p.banner = banner;
      p.updatedAt = Date.now();
      writeData(ensureData());
      ok(res, { pfp: { avatar: p.avatar, banner: p.banner, updatedAt: p.updatedAt } });
    } catch (e) { fail(res, e); }
  });

  // Bulk library operations must not run against a partial team/application view.
  // Re-load empty teams through the team endpoint and fail closed on any error.
  async function loadCompleteTsApplicationLibrary({ token, netOpts = {} }) {
    const [teams, apps] = await Promise.all([
      ts.listTeams({ token, netOpts }),
      ts.listApplications({ token, netOpts }),
    ]);
    const allApps = Array.isArray(apps) ? apps.slice() : [];
    const seenApps = new Set(allApps.map(a => String(a?.id || '')).filter(Boolean));
    const teamErrors = [];
    for (const team of teams || []) {
      try {
        const teamApps = await ts.listTeamApplications({ token, teamId: team.id, netOpts });
        for (const app of teamApps || []) {
          const id = String(app?.id || '');
          if (id && !seenApps.has(id)) {
            seenApps.add(id);
            allApps.push(app);
          }
        }
      } catch (error) {
        teamErrors.push({
          teamId: team.id,
          code: error?.code || 'TEAM_APPS_FAILED',
          status: error?.status || 0,
          message: error?.message || String(error),
        });
      }
    }
    if (teamErrors.length) {
      const err = new Error(`Library is incomplete; ${teamErrors.length} team application list(s) could not be verified`);
      err.code = 'LIBRARY_INCOMPLETE';
      err.details = teamErrors;
      throw err;
    }
    return { teams, apps: allApps };
  }

  // SSE streaming version — streams per-bot progress in real-time.
  // Events: {type:'start',total}, {type:'progress',index,total,appId,name,ok,error,appOk,appError},
  //         {type:'done',okCount,failCount}, {type:'error',error}
  app.post('/api/ts/pfp/apply-all', async (req, res) => {
    const p = tsPfpSettings();
    if (!p.avatar && !p.banner) {
      res.status(400).json({ success: false, error: 'Save an avatar or banner first' });
      return;
    }
    const email = String(req.body?.email || '').toLowerCase();
    const selectedIds = new Set(Array.isArray(req.body?.appIds) ? req.body.appIds.map(String) : []);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const endStream = () => { if (!res.writableEnded) res.end(); };

    try {
      if (!email) throw new Error('اختر حساباً أولاً');

      if (isTsAccountQueued(email)) send({ type: 'queued', account: email });
      await enqueueTsAccount(email, async () => {
        const { token, client } = await tsGetToken(email);
        const rateLimiter = makeTsRateLimiter('pfp-apply-all', send, { minimumGapMs: 750, account: email });
        const netOpts = { client, solveCaptcha: buildSolveCaptcha(), rateLimiter, captchaContext: 'pfp-apply-all' };
        const health = await ts.accountHealthProbe({ token, netOpts });
        if (!health.ready) throw new Error('Account is not ready: ' + health.message);

        const { apps: libApps } = await loadCompleteTsApplicationLibrary({ token, netOpts });
        const bots = libApps.filter(a => a && a.bot && a.id && (!selectedIds.size || selectedIds.has(String(a.id))));
        if (!bots.length) throw new Error(selectedIds.size ? 'لا توجد بوتات محددة قابلة للتنفيذ' : 'لا توجد بوتات في المكتبة');

        send({ type: 'start', total: bots.length });

        let okCount = 0, failCount = 0;

        for (let i = 0; i < bots.length; i++) {
          const bot = bots[i];
          let botOk = false, botErr = null, appOk = false, appErr = null;

          try {
            await withTsRateRetry(`تحديث صورة البوت ${bot.name || bot.id}`, () =>
              ts.updateBotProfileViaOwner({
                token, appId: bot.id,
                avatar: p.avatar || undefined,
                banner: p.banner || undefined,
                netOpts,
              }),
              { attempts: 2, send }
            );
            botOk = true;
          } catch (e) {
            botErr = e.message || String(e);
          }

          try {
            await withTsRateRetry(`تحديث صورة التطبيق ${bot.name || bot.id}`, () =>
              ts.updateAppVisuals({
                token, appId: bot.id,
                icon:       p.avatar || undefined,
                coverImage: p.banner || undefined,
                netOpts,
              }),
              { attempts: 2, send }
            );
            appOk = true;
          } catch (e) {
            appErr = e.message || String(e);
          }

           // The operation promises both bot and application visuals. A bot
           // profile update alone is only a partial success and must be
           // reported as such so the UI does not claim everything was applied.
           const overallOk = botOk && appOk;
          if (overallOk) okCount++; else failCount++;

          send({
            type: 'progress',
            index: i + 1, total: bots.length,
            appId: bot.id, name: bot.name || bot.id,
            ok: overallOk,
            partial: !overallOk && (botOk || appOk),
            error: [botErr, appErr].filter(Boolean).join(' | ') || undefined,
            botOk,
            botError: botErr || undefined,
            appOk,
            appError: appErr || undefined,
          });

          if (i < bots.length - 1) {
            if ((i + 1) % 10 === 0) await tsSleep(10_000 + Math.floor(Math.random() * 8_000));
            else await ts.humanDelay(1200, 2600);
          }
        }

        send({ type: 'done', okCount, failCount });
      }, { label: 'Apply all PFP' });
    } catch (e) {
      send({ type: 'error', error: e.message || String(e) });
    } finally {
      endStream();
    }
  });

  app.get('/api/ts/applications/:appId/intents', async (req, res) => {
    try {
      const appId = String(req.params.appId || '').trim();
      const email = String(req.query.email || '').toLowerCase();
      if (!appId || !email) throw new Error('Application id and email are required');
      const { token, client } = await tsGetToken(email);
      const health = await ts.accountHealthProbe({ token, netOpts: { client } });
      if (!health.ready) return ok(res, { appId, blocked: true, health });
      const appObj = await ts.getApplication({ token, appId, netOpts: { client } });
      ok(res, { appId, app: { id: appObj.id, name: appObj.name, flags: appObj.flags, flags_new: appObj.flags_new }, intents: ts.normalizeIntentState(appObj), health });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/ts/applications/:appId/intents', async (req, res) => {
    try {
      const appId = String(req.params.appId || '').trim();
      const email = String(req.body?.email || '').toLowerCase();
      const enabled = req.body?.enabled !== false;
      if (!appId || !email) throw new Error('Application id and email are required');
      const result = await enqueueTsAccount(email, async () => {
        const { token, client } = await tsGetToken(email);
        const rateLimiter = makeTsRateLimiter('single-intents', null, { minimumGapMs: 500, account: email });
        const netOpts = { client, solveCaptcha: buildSolveCaptcha(), rateLimiter, captchaContext: 'single-intents' };
        const health = await ts.accountHealthProbe({ token, netOpts });
        if (!health.ready) throw new Error('Account is not ready for intent update: ' + health.message);
        const updated = await withTsRateRetry('تفعيل iNTeNTs', () =>
          ts.setApplicationIntents({ token, appId, enabled, netOpts }),
          { attempts: 2 }
        );
        return {
          appId,
          intents: ts.normalizeIntentState(updated),
          operation: updated.operation || { requestedEnabled: enabled, confirmed: true, partial: false },
          app: { id: updated.id, name: updated.name, flags: updated.flags, flags_new: updated.flags_new },
          health,
        };
      }, { label: 'Single intents' });
      ok(res, result);
    } catch (e) { fail(res, e); }
  });

  app.post('/api/ts/intents/apply-all', async (req, res) => {
    try {
      const email = String(req.body?.email || '').toLowerCase();
      const enabled = req.body?.enabled !== false;
      const selectedIds = new Set(Array.isArray(req.body?.appIds) ? req.body.appIds.map(String) : []);
      if (!email) throw new Error('Email is required');
      const payload = await enqueueTsAccount(email, async () => {
        const { token, client } = await tsGetToken(email);
        const rateLimiter = makeTsRateLimiter('intents-apply-all', null, { minimumGapMs: 700, account: email });
        const netOpts = { client, solveCaptcha: buildSolveCaptcha(), rateLimiter, captchaContext: 'intents-apply-all' };
        const health = await ts.accountHealthProbe({ token, netOpts });
        if (!health.ready) throw new Error('Account readiness blocked bulk intent update: ' + health.message);
        const { apps: libApps } = await loadCompleteTsApplicationLibrary({ token, netOpts });
        const bots = libApps.filter(a => a && a.bot && a.id && (!selectedIds.size || selectedIds.has(String(a.id))));
        const results = [];
        for (let i = 0; i < bots.length; i++) {
          const appObj = bots[i];
          const currentState = ts.normalizeIntentState(appObj);
          const allEnabled = Object.values(currentState.state || {}).every(s => s.enabled);
          if (enabled && allEnabled) {
            results.push({ appId: appObj.id, name: appObj.name, ok: true, skipped: true });
            continue;
          }
          const allDisabled = Object.values(currentState.state || {}).every(s => !s.enabled);
          if (!enabled && allDisabled) {
            results.push({ appId: appObj.id, name: appObj.name, ok: true, skipped: true });
            continue;
          }
          try {
            const updated = await withTsRateRetry(`تفعيل iNTeNTs على ${appObj.name || appObj.id}`, () =>
              ts.setApplicationIntents({ token, appId: appObj.id, enabled, netOpts, app: appObj }),
              { attempts: 2 }
            );
            const operation = updated.operation || { requestedEnabled: enabled, confirmed: true, partial: false };
            results.push({
              appId: appObj.id,
              name: appObj.name,
              ok: operation.confirmed === true,
              partial: operation.partial === true,
              skipped: false,
              error: operation.confirmed === true ? null : (operation.approvedRemain ? 'Approved intents remain enabled' : 'Intents update was not confirmed'),
              intents: ts.normalizeIntentState(updated),
              operation,
            });
          } catch (e) {
            results.push({ appId: appObj.id, name: appObj.name, ok: false, skipped: false, error: e.message || String(e), status: e.status || 0, code: e.code || '' });
          }
          if (i < bots.length - 1) {
            if ((i + 1) % 15 === 0) await tsSleep(12_000 + Math.floor(Math.random() * 10_000));
            else await ts.humanDelay(1300, 2800);
          }
        }
        const okCount = results.filter(r => r.ok).length;
        const failCount = results.filter(r => !r.ok).length;
        const skippedCount = results.filter(r => r.skipped).length;
        return { results, okCount, failCount, skippedCount, health };
      }, { label: 'Apply all intents' });
      ok(res, payload);
    } catch (e) { fail(res, e); }
  });

  // Auto-intents setting: when ON, any new bot created via the session gets all 3 intents enabled automatically
  app.get('/api/ts/auto-intents', (req, res) => {
    try {
      const d = ensureData();
      ok(res, { autoIntents: !!d.tsAutoIntents });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/ts/auto-intents', (req, res) => {
    try {
      const d = ensureData();
      d.tsAutoIntents = !!req.body?.enabled;
      writeData(d);
      ok(res, { autoIntents: d.tsAutoIntents });
    } catch (e) { fail(res, e); }
  });

  function profileConfig(input = {}) {
    const rules = input.rules || {};
    return {
      rules: { createTeams: !!rules.createTeams, createBots: !!rules.createBots, linkBots: !!rules.linkBots },
      count: Math.max(1, Math.min(50, parseInt(input.count) || 1)),
      prefix: String(input.prefix || 'Bot').slice(0, 24).trim() || 'Bot',
      waitMinutes: Math.max(0, Math.min(60, parseInt(input.waitMinutes) || 0)),
      proxyUrl: typeof input.proxyUrl === 'string' ? input.proxyUrl.slice(0, 20000) : '',
      speed: ['medium', 'fast', 'veryfast', 'ultra'].includes(input.speed) ? input.speed : 'medium',
      selectedTeamId: typeof input.selectedTeamId === 'string' ? input.selectedTeamId.slice(0, 64) : '',
      brightData: input.brightData && typeof input.brightData === 'object' ? {
        enabled: input.brightData.enabled === true,
        customerId: String(input.brightData.customerId || '').slice(0, 160),
        zoneName: String(input.brightData.zoneName || '').slice(0, 160),
        protocol: input.brightData.protocol === 'socks5h' ? 'socks5h' : 'http',
      } : { enabled: false },
      batchSize: Math.max(1, Math.min(5, parseInt(input.batchSize) || 1)),
      sessionBudget: Math.max(0, Math.min(500, parseInt(input.sessionBudget) || 0)),
    };
  }

  function publicProfile(p) {
    const config = { ...(p?.config || {}) };
    if (config.proxyUrlEncrypted) {
      config.proxyUrl = tryDecrypt(config.proxyUrl) || '';
      delete config.proxyUrlEncrypted;
    }
    return { id: p.id, name: p.name, config, updatedAt: p.updatedAt };
  }
  function publicSession(last) {
    if (!last) return null;
    const session = { ...last, config: last.config ? { ...last.config } : null };
    if (session.config?.proxyUrlEncrypted) {
      session.config.proxyUrl = tryDecrypt(session.config.proxyUrl) || '';
      delete session.config.proxyUrlEncrypted;
    }
    return session;
  }

  app.get('/api/ts/profiles', (req, res) => {
    const d = ensureData();
    ok(res, { profiles: (d.tsProfiles || []).map(publicProfile) });
  });
  app.post('/api/ts/profiles', (req, res) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 40);
      if (!name) return fail(res, new Error('Profile name is required'));
      const d = ensureData();
      const id = String(req.body?.id || '').trim().slice(0, 80) || ('profile-' + Date.now().toString(36));
      const config = profileConfig(req.body?.config || {});
      if (config.proxyUrl) { config.proxyUrl = encrypt(config.proxyUrl); config.proxyUrlEncrypted = true; }
      const record = { id, name, config, updatedAt: Date.now() };
      const index = (d.tsProfiles || []).findIndex(p => p.id === id);
      if (index >= 0) d.tsProfiles[index] = record;
      else d.tsProfiles.unshift(record);
      d.tsProfiles = d.tsProfiles.slice(0, 20);
      writeData(d);
      ok(res, { profile: publicProfile(record), profiles: d.tsProfiles.map(publicProfile) });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/ts/profiles/:id', (req, res) => {
    const d = ensureData();
    const id = String(req.params.id || '').trim();
    d.tsProfiles = (d.tsProfiles || []).filter(p => p.id !== id);
    writeData(d);
    ok(res, { profiles: d.tsProfiles });
  });

  app.post('/api/ts/dry-run', (req, res) => {
    try {
      const cfg = profileConfig(req.body || {});
      const email = String(req.body?.email || '').trim().toLowerCase();
      const acct = email ? tsFindAccount(email) : null;
      const creds = acct ? tsDecryptAccount(acct) : null;
      const checks = [
        { key: 'account', label: 'الحساب موجود', ok: !!acct, detail: acct ? 'تم العثور على الحساب' : 'اختر حساباً محفوظاً' },
        { key: 'credentials', label: 'بيانات الدخول', ok: !!(creds?.password || creds?.directToken), detail: creds ? 'بيانات الاعتماد موجودة' : 'لا يمكن الفحص قبل اختيار الحساب' },
        { key: 'rules', label: 'قواعد الجلسة', ok: !!(cfg.rules.createTeams || cfg.rules.createBots || cfg.rules.linkBots) && !(cfg.rules.linkBots && !cfg.rules.createBots), detail: cfg.rules.linkBots && !cfg.rules.createBots ? 'الربط يحتاج إنشاء البوتات' : 'القواعد متوافقة' },
        { key: 'count', label: 'الكمية', ok: !cfg.rules.createBots || cfg.count >= 1, detail: `${cfg.count} بوت كحد أقصى لهذه الجلسة` },
        { key: 'proxy', label: 'إعداد البروكسي', ok: !cfg.brightData.enabled || !!(cfg.brightData.customerId && cfg.brightData.zoneName), detail: cfg.brightData.enabled ? 'بيانات Bright Data الأساسية موجودة' : 'بدون Bright Data' },
      ];
      const passed = checks.every(c => c.ok);
      ok(res, { ok: passed, checks, plan: { account: email || null, steps: [cfg.rules.createTeams && 'إنشاء أو تجهيز التيم', cfg.rules.createBots && `إنشاء ${cfg.count} بوت`, cfg.rules.linkBots && 'ربط البوتات بالتيم', 'حفظ التوكنات والتقرير'].filter(Boolean) } });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/ts/resume', (req, res) => {
    const d = ensureData();
    const last = d.tsLastSession;
    ok(res, { available: !!(last && last.config && last.state !== 'done'), session: publicSession(last) });
  });

  // ── Bot invite helpers ─────────────────────────────────────────────────
  // Returns guilds where the selected account has MANAGE_GUILD or ADMINISTRATOR.
  app.get('/api/ts/bot-invite-guilds', async (req, res) => {
    try {
      const email = String(req.query.email || '').toLowerCase();
      if (!email) return fail(res, new Error('email required'));
      const { token, client } = await tsGetToken(email);
      const netOpts = { client };
      const raw = await ts.getUserGuildsWithPerms({ token, netOpts });
      const ADMIN  = BigInt(0x8);
      const MANAGE = BigInt(0x20);
      const guilds = raw.filter(g => {
        try {
          const p = BigInt(g.permissions || '0');
          return (p & ADMIN) === ADMIN || (p & MANAGE) === MANAGE;
        } catch { return !!g.owner; }
      }).map(g => ({
        id:    g.id,
        name:  g.name,
        icon:  g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
        owner: !!g.owner,
      }));
      ok(res, { guilds });
    } catch (e) { fail(res, e); }
  });

  // SSE: adds a bot to one guild, streaming step-by-step progress.
  app.post('/api/ts/bot-add-to-guild', async (req, res) => {
    const { email, appId, guildId, permissions = '8' } = req.body || {};

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send    = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    const endSSE  = ()  => { if (!res.writableEnded) res.end(); };

    try {
      if (!email || !appId || !guildId) throw new Error('email و appId و guildId مطلوبون');
      if (isTsAccountQueued(email)) send({ type: 'queued', account: email });
      let result = null;
      await enqueueTsAccount(email, async () => {
        send({ type: 'step', msg: 'جاري التحقق من الحساب…' });
        const { token, client } = await tsGetToken(email);
        const rateLimiter = makeTsRateLimiter('bot-add-to-guild', send, { minimumGapMs: 900, account: email });
        const netOpts = { client, solveCaptcha: buildSolveCaptcha(), rateLimiter, captchaContext: 'bot-add-to-guild' };
        const health = await ts.accountHealthProbe({ token, netOpts });
        if (!health.ready) throw new Error('Account is not ready: ' + health.message);

        send({ type: 'step', msg: 'جاري إضافة البوت إلى السيرفر…' });
        result = await withTsRateRetry('إضافة البوت للسيرفر', () =>
          ts.addBotToGuild({ token, clientId: appId, guildId, permissions: String(permissions), netOpts }),
          { attempts: 0, send, minWaitMs: 60_000, idempotent: false }
        );
      }, { label: 'Add bot to guild' });

      send({ type: 'done', appId, guildId, alreadyPresent: !!result?.alreadyPresent, verified: result?.verified === true });
    } catch (e) {
      send({ type: 'error', error: e.message || String(e) });
    } finally {
      endSSE();
    }
  });

  /* ── Bulk add: add multiple bots to one guild via SSE ─────────────── */
  app.post('/api/ts/bot-bulk-add-to-guild', async (req, res) => {
    const { email, appIds, guildId, permissions = '8' } = req.body || {};

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send   = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    const endSSE = ()  => { if (!res.writableEnded) res.end(); };

    try {
      if (!email || !Array.isArray(appIds) || !appIds.length || !guildId)
        throw new Error('email, appIds[], و guildId مطلوبون');

      if (isTsAccountQueued(email)) send({ type: 'queued', account: email });
      await enqueueTsAccount(email, async () => {
        const { token, client } = await tsGetToken(email);
        const rateLimiter = makeTsRateLimiter('bot-bulk-add-to-guild', send, { minimumGapMs: 1000, account: email });
        const netOpts = { client, solveCaptcha: buildSolveCaptcha(), rateLimiter, captchaContext: 'bot-bulk-add-to-guild' };

        const health = await ts.accountHealthProbe({ token, netOpts });
        if (!health.ready) throw new Error('Account is not ready: ' + health.message);

        send({ type: 'start', total: appIds.length });

        let okCount = 0, failCount = 0, skipCount = 0;

        for (let i = 0; i < appIds.length; i++) {
          const appId = appIds[i];
          let succeeded = false;
          let lastErr   = null;
          let skipped   = false;

          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const result = await ts.addBotToGuild({ token, clientId: appId, guildId, permissions: String(permissions), netOpts });
              if (result?.alreadyPresent) {
                skipped = true;
                skipCount++;
              } else {
                succeeded = result?.verified === true;
                if (succeeded) okCount++;
                else lastErr = new Error('Invite was not verified');
              }
              break;
            } catch (e) {
              if (e.status === 429 || e.code === 'RATE_LIMITED') {
                const retryMs = Math.max(retryAfterMs(e), 60_000);
                lastErr = Object.assign(new Error(`Rate limit أثناء دعوة ${appId} — أعد المحاولة بعد ${Math.ceil(retryMs / 1000)} ثانية`), {
                  code: 'RATE_LIMITED', retryAfterMs: retryMs,
                });
                send({ type: 'rate_limit', index: i + 1, total: appIds.length, appId, retryAfterMs: retryMs, retryable: true });
                // Invite is a side-effecting POST. Do not resend it after a
                // 429 because Discord may have accepted the first request.
                break;
              } else if (e.status === 403) {
                // 403 is not proof that the bot is already present. Discord
                // also uses it for missing guild permissions and policy
                // rejection, so report it as a real failure.
                lastErr = e;
                break;
              } else if (e.code === 'CAPTCHA' || e.code === 'CAPTCHA_REQUIRED' || e.code === 'CAPTCHA_FAILED' || e.captchaSitekey) {
                lastErr = new Error('Captcha required/failed while adding this bot: ' + (e.message || e));
                break;
              } else {
                lastErr = e;
                break;
              }
            }
          }

          if (!succeeded && !skipped) failCount++;

          send({
            type:    'progress',
            index:   i + 1,
            total:   appIds.length,
            appId,
            ok:      succeeded,
            skipped,
            error:   (!succeeded && lastErr) ? (lastErr.message || String(lastErr)) : undefined,
          });

          if (i < appIds.length - 1) {
            if ((i + 1) % 8 === 0) await tsSleep(12_000 + Math.floor(Math.random() * 8_000));
            else await ts.humanDelay(1800, 3600);
          }
        }

        send({ type: 'done', okCount, failCount, skipCount });
      }, { label: 'Bulk add bots to guild' });
    } catch (e) {
      send({ type: 'error', error: e.message || String(e) });
    } finally {
      endSSE();
    }
  });

  // Pre-flight: log in (and verify TOTP if a 2FA secret is saved) WITHOUT
  // creating any team or bot. Result is stored on the account so the UI can
  // show a green "verified" badge until next session.
  app.post('/api/ts/test-account', async (req, res) => {
    const target = String((req.body && req.body.email) || '').toLowerCase();
    const acct = tsFindAccount(target);
    if (!acct) return fail(res, new Error('Account not found'));
    const creds = tsDecryptAccount(acct);
    if (!creds.password && !creds.directToken) return fail(res, new Error('Saved account has no password and no direct token — re-save it'));
    try {
      const client = ts.createClient();
      const netOpts = { solveCaptcha: buildSolveCaptcha(), client };
      const verify = { ok: false, status: 'unknown', message: '', user: null, mfa: !!creds.totpSecret, at: Date.now() };
      try {
        let token, userId;
        if (creds.directToken) {
          // Direct token path — no login needed, verify it immediately
          token = creds.directToken;
          tsLog('info', 'اختبار التوكن المباشر…');
        } else {
          const r = await ts.login({
            email: creds.email, password: creds.password, totpSecret: creds.totpSecret, netOpts,
          });
          token = r.token; userId = r.userId;
        }
        // Use the same warmed client for /users/@me so cookies match
        const meR = await client.http.get('https://discord.com/api/v9/users/@me', {
          headers: {
            Authorization: token,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'X-Super-Properties': client.superPropsB64,
            'X-Fingerprint': client.fingerprint || undefined,
            'Origin': 'https://discord.com',
            'Referer': 'https://discord.com/channels/@me',
          },
          timeout: 15000, validateStatus: () => true,
        }).catch(() => ({ status: 0, data: null }));
        if (meR.status >= 400) {
          verify.status = 'token_unusable';
          verify.message = `Login OK but /users/@me returned ${meR.status}`;
        } else {
          verify.ok = true;
          verify.status = 'verified';
          verify.user = {
            id: meR.data?.id || userId || null,
            username: meR.data?.username || '',
            globalName: meR.data?.global_name || '',
            mfa_enabled: !!meR.data?.mfa_enabled,
            verified: !!meR.data?.verified,
          };
          const health = await ts.accountHealthProbe({ token, netOpts: { client } });
          verify.health = health;
          if (!health.ready) {
            verify.ok = false;
            verify.status = health.classification;
            verify.message = health.message;
          } else {
            verify.ok = true;
            verify.message = 'Account verified and ready — no active rate-limit/lock detected';
            // Cache token + the warmed client only after the full ready check.
            tsStoreToken(creds.email, token, client);
          }
        }
      } catch (e) {
        verify.status = e.code || 'login_failed';
        verify.message = e.message || String(e);
      }
      // Persist the result (without exposing the token)
      const d = ensureData();
      const rec = (d.tsAccounts || []).find(a => (a.email || '').toLowerCase() === target);
      if (rec) {
        rec.verify = {
          ok: !!verify.ok,
          status: verify.status,
          message: verify.message,
          mfa: verify.mfa,
          username: verify.user?.username || '',
          userId: verify.user?.id || '',
          at: verify.at,
        };
        writeData(d);
      }
      ok(res, { verify, accounts: tsAccountsPublic() });
    } catch (e) {
      fail(res, e);
    }
  });

  // Library: fetch the account's full Discord developer state — every team
  // and every application/bot the user owns — and group apps by their team_id.
  // Powers the visual library cards (matches the screenshot mockup).
  app.get('/api/ts/library', async (req, res) => {
    const email = String(req.query.email || '').toLowerCase();
    if (!email) return fail(res, new Error('Email is required'));
    try {
      const { token, client } = await tsGetToken(email);
      const netOpts = { solveCaptcha: buildSolveCaptcha(), client };

      // Do not turn Discord/API failures into an apparently empty library.
      // An empty account is valid; an unavailable endpoint is not.
      const [teamsResult, appsResult, meResult] = await Promise.allSettled([
        ts.listTeams({ token, netOpts }),
        ts.listApplications({ token, netOpts }),
        ts.getCurrentUser({ token, netOpts }),
      ]);
      const libraryFailure = [teamsResult, appsResult, meResult]
        .find(r => r.status === 'rejected');
      if (libraryFailure) {
        throw libraryFailure.reason instanceof Error
          ? libraryFailure.reason
          : new Error(String(libraryFailure.reason || 'Unable to load Discord library'));
      }
      const teams = teamsResult.value;
      const apps = appsResult.value;
      const me = meResult.value;

      const currentUserId = me?.id || null;

      // Helper to map a raw Discord application object to our card shape
      function toCard(a) {
        return {
          id: a.id,
          name: a.name,
          icon: a.icon || null,
          isBot: !!a.bot,
          botId: a.bot?.id || null,
          botUsername: a.bot?.username || null,
          createdAt: snowflakeToTs(a.id),
        };
      }

      // Index teams by id — keep member info so frontend can show owner/member badge
      const teamMap = new Map();
      for (const t of teams) {
        // Find the current user's role in this team
        let myRole = null;
        if (currentUserId && Array.isArray(t.members)) {
          const me = t.members.find(m => m.user?.id === currentUserId);
          myRole = me?.role || null;
        }
        // Fallback: if owner_user_id matches, role is owner
        if (!myRole && t.owner_user_id === currentUserId) myRole = 'owner';

        teamMap.set(t.id, {
          id: t.id,
          name: t.name,
          icon: t.icon || null,
          ownerUserId: t.owner_user_id || null,
          isOwner: t.owner_user_id === currentUserId,
          myRole: myRole || (t.owner_user_id === currentUserId ? 'owner' : 'member'),
          memberCount: Array.isArray(t.members) ? t.members.length : null,
          apps: [],
          appsFromTeamEndpoint: false,
        });
      }

      // Map apps from /applications — these are apps owned by the current user
      const personal = [];
      for (const a of apps) {
        const card = toCard(a);
        const tid = a.team?.id || a.team_id || null;
        if (tid && teamMap.has(tid)) {
          teamMap.get(tid).apps.push(card);
        } else if (tid && !teamMap.has(tid)) {
          // App references a team not in /teams — synthesize the team entry
          teamMap.set(tid, {
            id: tid,
            name: a.team?.name || ('Team ' + tid.slice(0, 6)),
            icon: a.team?.icon || null,
            ownerUserId: a.team?.owner_user_id || null,
            isOwner: a.team?.owner_user_id === currentUserId,
            myRole: a.team?.owner_user_id === currentUserId ? 'owner' : 'member',
            memberCount: null,
            apps: [card],
            appsFromTeamEndpoint: false,
          });
        } else {
          personal.push(card);
        }
      }

      // For teams where the /applications endpoint returned 0 apps (typically
      // teams where the user is a MEMBER, not the owner), fetch apps via
      // GET /teams/:teamId/applications which works for all roles.
      const emptyTeamIds = Array.from(teamMap.values())
        .filter(t => t.apps.length === 0)
        .map(t => t.id);

      const teamLoadErrors = [];
      if (emptyTeamIds.length) {
        const teamAppResults = await Promise.all(
          emptyTeamIds.map(tid =>
            ts.listTeamApplications({ token, teamId: tid, netOpts })
              .then(list => ({ tid, list, error: null }))
              .catch(error => ({
                tid,
                list: [],
                error: {
                  status: error?.status || 0,
                  code: error?.code || 'TEAM_APPS_FAILED',
                  message: error?.message || String(error),
                },
              }))
          )
        );
        for (const { tid, list, error } of teamAppResults) {
          if (error) {
            teamLoadErrors.push({ teamId: tid, ...error });
            continue;
          }
          if (!list.length) continue;
          const entry = teamMap.get(tid);
          if (!entry) continue;
          for (const a of list) {
            entry.apps.push(toCard(a));
          }
          entry.appsFromTeamEndpoint = true;
        }
      }

      const TEAM_APP_LIMIT = 25;
      const teamsOut = Array.from(teamMap.values()).map(t => ({
        ...t,
        appLimit: TEAM_APP_LIMIT,
        apps: t.apps.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      }));

      ok(res, {
        teams: teamsOut,
        personal: personal.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
        currentUserId,
        complete: teamLoadErrors.length === 0,
        warnings: teamLoadErrors,
        totals: { teams: teamsOut.length, apps: apps.length, personalApps: personal.length },
      });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Proxy verification ──────────────────────────────────────────────────
  // Tests that a proxy URL is reachable and returns the egress IP.
  // required:true  = must pass for bot-creation to work
  // required:false = optional (not needed for creating bots)
  // Only discord.com endpoints are truly required — everything else is optional.
  const TS_PROXY_PREFLIGHT_TARGETS = [
    // discord.com/login is the reliable required check — works even on "Limited Access" BrightData plans.
    // /api/ paths are blocked by BrightData robots.txt enforcement on Limited Access plans;
    // however WebSocket (bot) connections bypass this since they're not HTTP crawl requests.
    { id: 'discord-login',   label: 'Discord (login page)',  url: 'https://discord.com/login',              required: true  },
    { id: 'discord-api',     label: 'Discord API (/api)',    url: 'https://discord.com/api/v10/gateway',    required: false },
    { id: 'discordapp',      label: 'Discord (legacy)',      url: 'https://discordapp.com',                 required: false },
    { id: 'cdn-discordapp',  label: 'Discord CDN (avatars)', url: 'https://cdn.discordapp.com',             required: false },
    { id: 'media-discordapp',label: 'Discord media CDN',     url: 'https://media.discordapp.net',           required: false },
  ];

  async function runBrightDataPreflight(bd, { testCount = 3 } = {}) {
    const checks = [];
    const rotationChecks = [];
    const rotationCount = Math.max(1, Math.min(5, Number(testCount || 3)));

    // Rotation check: use discord.com/login — proves Discord is reachable + IP rotation.
    // We avoid /api/ paths here because "Limited Access" BrightData plans may block them.
    for (let i = 0; i < rotationCount; i++) {
      const sessionId = 'preflight_rot_' + Date.now().toString(36) + '_' + i + '_' + Math.random().toString(36).slice(2, 6);
      try {
        const result = await testProxy(buildBrightDataUrl(bd, sessionId), {
          targetUrl: 'https://discord.com/login',
          timeoutMs: 12000,
          insecureSkipTlsVerify: true,
          acceptStatus: (s) => s >= 100 && s < 600,
        });
        rotationChecks.push({ ok: true, ip: result.ip || null, country: result.country || null, status: result.status || null, sessionId });
      } catch (e) {
        rotationChecks.push({ ok: false, ip: null, country: null, error: e.message || String(e), sessionId });
      }
    }

    // Target checks — run only required targets + a sample of optional ones in parallel.
    await Promise.all(TS_PROXY_PREFLIGHT_TARGETS.map(async (target, idx) => {
      const sessionId = 'preflight_target_' + idx + '_' + Math.random().toString(36).slice(2, 6);
      try {
        const result = await testProxy(buildBrightDataUrl(bd, sessionId), {
          targetUrl: target.url,
          timeoutMs: 12000,
          insecureSkipTlsVerify: true,
          acceptStatus: (status) => status >= 100 && status < 600,
        });
        checks[idx] = { ...target, ok: true, status: result.status || null, ip: result.ip || null, country: result.country || null };
      } catch (e) {
        checks[idx] = { ...target, ok: false, error: e.message || String(e) };
      }
    }));

    const okRotation = rotationChecks.filter(c => c.ok);
    const uniqueRotation = Array.from(new Set(okRotation.map(c => c.ip || c.country || '').filter(Boolean)));
    // Only fail if a REQUIRED target fails — optional failures are just warnings.
    const failedRequired = checks.filter(c => c.required && !c.ok);
    // If all rotation checks failed, that's also a hard failure.
    const rotationFailed = okRotation.length === 0;
    return {
      ok: !rotationFailed && failedRequired.length === 0,
      rotation: {
        ok: okRotation.length > 0,
        checks: rotationChecks,
        testedSessions: rotationChecks.length,
        uniqueCount: uniqueRotation.length,
        rotationLikely: uniqueRotation.length > 1,
      },
      targets: checks,
      failedTargets: failedRequired,
    };
  }

  app.post('/api/ts/proxy-verify', async (req, res) => {
    const { proxyUrl, brightData } = req.body || {};
    let url = typeof proxyUrl === 'string' ? proxyUrl.trim() : '';
    if (!url && brightData?.enabled) {
      const bd = resolveBrightDataConfig(brightData, { useSavedPassword: true, useSavedFields: true });
      if (!bd) return ok(res, { ok: false, ip: null, error: 'Bright Data settings are incomplete' });
      const testCount = Math.max(1, Math.min(5, Number(req.body?.testCount || 3)));
      const checks = [];
      for (let i = 0; i < testCount; i++) {
        const sessionId = 'test_' + Date.now().toString(36) + '_' + i + '_' + Math.random().toString(36).slice(2, 6);
        const testUrl = buildBrightDataUrl(bd, sessionId);
        try {
          const result = await testProxy(testUrl);
          checks.push({ ok: true, ip: result.ip || null, country: result.country || null, sessionId });
        } catch (e) {
          checks.push({ ok: false, ip: null, error: e.message || String(e), sessionId });
        }
      }
      const okChecks = checks.filter(c => c.ok);
      const uniqueIps = Array.from(new Set(okChecks.map(c => c.ip).filter(Boolean)));
      const uniqueLocations = Array.from(new Set(okChecks.map(c => c.ip || c.country || '').filter(Boolean)));
      return ok(res, {
        ok: okChecks.length > 0,
        ip: okChecks[0]?.ip || null,
        ips: checks,
        uniqueIpCount: uniqueIps.length,
        uniqueLocationCount: uniqueLocations.length,
        testedSessions: checks.length,
        rotationLikely: uniqueIps.length > 1 || uniqueLocations.length > 1,
        error: okChecks.length ? null : (checks.find(c => c.error)?.error || 'Bright Data proxy test failed'),
      });
    }
    if (!url) return fail(res, new Error('proxyUrl is required'));
    try {
      const result = await testProxy(url);
      ok(res, {
        ok: result.ok,
        ip: result.ip || null,
        country: result.country || null,
        targetUrl: result.targetUrl || null,
        error: result.error || null,
      });
    } catch (e) {
      ok(res, { ok: false, ip: null, error: e.message || String(e) });
    }
  });

  app.post('/api/ts/proxy-preflight', async (req, res) => {
    try {
      const bd = resolveBrightDataConfig(req.body?.brightData || { enabled: true }, {
        useSavedPassword: true,
        useSavedFields: true,
      });
      if (!bd) return ok(res, { ok: false, error: 'Bright Data settings are incomplete — احفظ Customer/Zone/Password أولاً' });
      const result = await runBrightDataPreflight(bd, { testCount: req.body?.testCount || 3 });
      ok(res, result);
    } catch (e) {
      ok(res, { ok: false, error: e.message || String(e) });
    }
  });

  // ── Standalone team management ──────────────────────────────────────────
  // List teams for the selected account (used by UI team-selector dropdown).
  app.get('/api/ts/teams', async (req, res) => {
    const email = String(req.query.email || '').toLowerCase().trim();
    if (!email) return fail(res, new Error('email is required'));
    try {
      const { token, client } = await tsGetToken(email);
      const netOpts = { solveCaptcha: buildSolveCaptcha(), client };
      const [teams, me] = await Promise.all([
        ts.listTeams({ token, netOpts }),
        ts.getCurrentUser({ token, netOpts }).catch(() => null),
      ]);
      const mapped = await Promise.all((teams || []).map(async t => {
        let appCount = Array.isArray(t.apps) ? t.apps.length : 0;
        try {
          const apps = await ts.listTeamApplications({ token, teamId: t.id, netOpts });
          if (Array.isArray(apps)) appCount = apps.length;
        } catch (_) {}
        return {
          id: t.id,
          name: t.name,
          icon: t.icon || null,
          appCount,
          appLimit: 25,
          isOwner: !!t.isOwner || (!!me?.id && t.owner_user_id === me.id),
        };
      }));
      ok(res, { teams: mapped });
    } catch (e) { fail(res, e); }
  });

  // Create a new team without starting a full automation session.
  app.post('/api/ts/teams/create', async (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const name = String(req.body?.name || '').trim().slice(0, 32);
    if (!email || !name) return fail(res, new Error('email and name are required'));
    if (!tsFindAccount(email)) return fail(res, new Error('Account not found — save it first'));
    try {
      const team = await enqueueTsAccount(email, async () => {
        const { token, client } = await tsGetToken(email);
        const rateLimiter = makeTsRateLimiter('create-team', null, { minimumGapMs: 900, account: email });
        const netOpts = { solveCaptcha: buildSolveCaptcha(), client, rateLimiter, captchaContext: 'create-team' };
        // Warm the portal before the mutation; a failed warm-up must not be hidden.
        if (!client.devPortalLoaded) {
          await ts.simulateBrowsing({ token, netOpts });
          await ts.humanDelay(800, 1800);
          await ts.loadDevPortal({ client, token, netOpts });
        }
        const health = await ts.accountHealthProbe({ token, netOpts });
        if (!health.ready) {
          const err = new Error(`Account is not ready: ${health.message}`);
          err.code = health.classification;
          err.retryAfter = health.retryAfter || health.resetAfter || 0;
          err.rateLimit = health;
          throw err;
        }
        await ts.navigateTo({ client, page: 'https://discord.com/developers/teams' });
        await ts.humanDelay(600, 1400);
        const created = await ts.createTeam({ token, name, netOpts });
        const teams = await ts.listTeams({ token, netOpts });
        const verified = teams.find(t => String(t?.id || '') === String(created.id));
        if (!verified) {
          const err = new Error('Team creation was not confirmed by Discord');
          err.code = 'TEAM_NOT_CONFIRMED';
          throw err;
        }
        return verified;
      }, { label: 'Create team' });
      ok(res, { team: { id: team.id, name: team.name, icon: team.icon || null, confirmed: true } });
    } catch (e) { fail(res, e); }
  });

  // Transfer an existing application to a team.
  // Requires the app to be owned by the user (personal app) and MFA if 2FA is enabled.
  app.post('/api/ts/teams/:teamId/add-app', async (req, res) => {
    const teamId = String(req.params.teamId || '').trim();
    const email = String(req.body?.email || '').toLowerCase().trim();
    const appId = String(req.body?.appId || '').trim();
    if (!teamId || !email || !appId) return fail(res, new Error('teamId, email and appId are required'));
    try {
      const acct = tsFindAccount(email);
      if (!acct) throw new Error('Account not found — save it first');
      const creds = tsDecryptAccount(acct);
      const result = await enqueueTsAccount(email, async () => {
        const { token, client } = await tsGetToken(email);
        const rateLimiter = makeTsRateLimiter('move-app-to-team', null, { minimumGapMs: 900, account: email });
        const netOpts = {
          solveCaptcha: buildSolveCaptcha(), client, rateLimiter, captchaContext: 'move-app-to-team',
          totpSecret: creds.totpSecret || undefined,
          password: creds.password || undefined,
        };
        const health = await ts.accountHealthProbe({ token, netOpts });
        if (!health.ready) {
          const err = new Error(`Account is not ready: ${health.message}`);
          err.code = health.classification;
          err.retryAfter = health.retryAfter || health.resetAfter || 0;
          err.rateLimit = health;
          throw err;
        }
        const me = await ts.getCurrentUser({ token, netOpts });
        const teams = await ts.listTeams({ token, netOpts });
        const target = teams.find(t => String(t?.id || '') === teamId);
        const isOwner = !!target && !!me?.id && String(target.owner_user_id || target.owner?.id || '') === String(me.id);
        if (!target || !isOwner) throw new Error('Team ownership could not be confirmed for this account');
        const teamApps = await ts.listTeamApplications({ token, teamId, netOpts });
        if (!Array.isArray(teamApps)) throw new Error('Team applications could not be verified');
        const existingInTeam = teamApps.find(a => String(a?.id || '') === appId);
        if (existingInTeam) return { ...existingInTeam, alreadyInTeam: true, confirmed: true };
        if (teamApps.length >= 25) throw new Error('Team capacity reached (25 applications)');
        const apps = await ts.listApplications({ token, netOpts });
        const source = apps.find(a => String(a?.id || '') === appId);
        if (!source) throw new Error('Application was not found in this account library');
        const ownerId = source.owner_user_id || source.owner?.id || source.owner?.user?.id || null;
        if (!ownerId || String(ownerId) !== String(me.id)) throw new Error('Application ownership could not be confirmed');
        const currentTeamId = source.team?.id || source.team_id || null;
        if (currentTeamId) throw new Error('Application is already assigned to a team');
        let mfaToken = null;
        if (creds.totpSecret) {
          mfaToken = await ts.acquireMfa({ token, totpSecret: creds.totpSecret, netOpts });
          if (!mfaToken) throw new Error('MFA authorization could not be confirmed');
        }
        const transferred = await ts.transferAppToTeam({ token, appId, teamId, mfa: mfaToken, netOpts });
        return { ...transferred, confirmed: true };
      }, { label: 'Move app to team' });
      ok(res, { app: { id: result.id, name: result.name, teamId, confirmed: result.confirmed !== false, alreadyInTeam: !!result.alreadyInTeam } });
    } catch (e) { fail(res, e); }
  });

  // Snowflake epoch (Discord) → ms timestamp
  function snowflakeToTs(id) {
    try { return Number(BigInt(id) >> 22n) + 1420070400000; } catch { return 0; }
  }

  // Reset a single bot's token. Used from the Library overlay so the user can
  // generate a fresh token for any bot (in any team or personal app) without
  // running the full automation session. Returns the new token in the response
  // (this is the only time it can be retrieved — the user must copy it now).
  //
  // The flow MIRRORS the creation pipeline so Discord doesn't reject the
  // request as suspicious (which manifests as an empty token in the response
  // and the user-visible "token not returned" error):
  //   1. ensure a logged-in token + dev-portal warm-up
  //   2. acquire an MFA-Authorization header when 2FA is enabled
  //   3. navigate the simulated browser to the app's bot page
  //   4. ensureBot — guarantees a bot user exists on the application
  //   5. resetBotToken — Discord returns the fresh token
  app.post('/api/ts/applications/:appId/reset-bot-token', async (req, res) => {
    const appId = String(req.params.appId || '').trim();
    const email = String((req.body && req.body.email) || '').toLowerCase();
    if (!appId) return fail(res, new Error('Application id is required'));
    if (!email) return fail(res, new Error('Email is required'));
    try {
      const acct = tsFindAccount(email);
      if (!acct) throw new Error('Account not found — save it first');
      const creds = tsDecryptAccount(acct);

      // 1) Get a working token + axios client (re-uses the cached session
      //    when valid; logs in fresh + handles captcha when not).
      const { token, client } = await tsGetToken(email);
      // Include totpSecret in netOpts so _request can auto-resolve MFA
      // challenges (code 60003 + ticket) transparently on any endpoint.
      const netOpts = {
        solveCaptcha: buildSolveCaptcha(),
        client,
        totpSecret: creds.totpSecret || undefined,
        // Password is passed so _req can auto-resolve MFA for accounts
        // that have NO 2FA enabled (Discord requires password verification
        // via POST /mfa/finish with mfa_type:"password" in that case).
        password: creds.password || undefined,
      };

      // Warm-up the dev portal once per cached client. Without this,
      // Discord sometimes returns 200 OK with an empty body on /bot/reset.
      if (!client.devPortalLoaded) {
        try {
          tsLog('info', 'محاكاة تصفح طبيعي قبل إعادة تعيين التوكن…');
          await ts.simulateBrowsing({ token, netOpts });
          await ts.humanDelay(600, 1200);
          tsLog('info', 'فتح Developer Portal…');
          await ts.loadDevPortal({ client, token, netOpts });
        } catch (e) {
          tsLog('warn', 'تعذر إكمال محاكاة التصفح: ' + (e.message || String(e)));
        }
      }

      // mfaToken is now handled automatically inside _request via the
      // 60003-ticket flow. We keep this variable for the _refreshMfa helper
      // below (used before each attempt as a best-effort pre-warm).
      let mfaToken = null;

      // Helper: map Discord MFA errors into clear user-facing messages.
      function _mapMfaError(e) {
        const code = e?.data?.code;
        const msg  = (e?.message || '').toLowerCase();
        const looksMfa = code === 60003 || /two[-\s]?factor|2fa|mfa/i.test(msg);
        if (!looksMfa) return null;
        if (!creds.totpSecret) {
          return new Error(
            'Discord rejected the reset: this account has no 2FA secret saved here. ' +
            'Open Bot-Studio, edit the account, paste the Discord 2FA TOTP secret, save, then retry.'
          );
        }
        return new Error(
          'Discord rejected the reset (Two-Factor required) even though a TOTP secret is saved. ' +
          'Re-check that the saved 2FA secret matches Discord (open Discord, User Settings, My Account, 2FA, then reveal or copy the secret), then retry.'
        );
      }

      // Helper: ensure a fresh MFA code is available before each reset attempt.
      async function _refreshMfa() {
        if (!creds.totpSecret) return;
        try {
          mfaToken = await ts.acquireMfa({ token, totpSecret: creds.totpSecret, netOpts });
        } catch (_) { /* best-effort */ }
      }

      // 3–4) Simulate a real user clicking "Reset Token":
      //   navigate info page → click Bot sidebar → read page → click button.
            // Token reset is a non-idempotent operation. Never repeat it automatically
      // after an ambiguous response because the first token may already be live.
      let newToken;
      for (let attempt = 1; attempt <= 1; attempt++) {
        tsLog('info', attempt === 1
          ? 'محاكاة النقر على "Reset Token" في Developer Portal…'
          : 'إعادة المحاولة اليدوية — تكرار محاكاة النقر…');

        // Simulate click navigation (info page → bot page + SPA GET requests)
        try {
          await ts.simulateResetTokenButtonClick({ client, token, appId, netOpts });
        } catch (e) {
          tsLog('warn', 'تعذرت محاكاة التصفح: ' + (e.message || String(e)));
        }

        // Ensure a bot user exists (idempotent — 400 = already a bot, ignored).
        try {
          await ts.ensureBot({ token, appId, netOpts });
          await ts.humanDelay(500, 900);
        } catch (e) {
          tsLog('error', 'تعذر تأكيد وجود البوت قبل إعادة التوكن: ' + (e.message || String(e)), {
            operation: 'ensure_bot', confirmed: false, stage: 'ensure_bot', appId,
          });
          throw e;
        }

        // Refresh MFA before every attempt (TOTP codes expire every 30s).
        await _refreshMfa();

        tsLog('info', `إعادة تعيين توكن البوت (محاولة ${attempt}/1)…`);
        try {
          newToken = await ts.resetBotToken({ token, appId, mfa: mfaToken, netOpts });
        } catch (e) {
          const mfaErr = _mapMfaError(e);
          if (mfaErr) throw mfaErr;
          if (attempt < 2) {
            tsLog('warn', `فشل المحاولة ${attempt} (${e.message || e}) — سيُعاد المحاولة…`);
            await ts.humanDelay(3000, 4500);
            continue;
          }
          throw e;
        }

        if (newToken && typeof newToken === 'string') break;

        // A 2xx response without a token is ambiguous for a side-effecting reset.
        // Fail closed and require a manual retry rather than risking a second reset.
        tsLog('error', 'Discord أرجع استجابة بلا توكن؛ أُوقفت إعادة المحاولة التلقائية لأن نتيجة العملية غير مؤكدة', {
          operation: 'reset_token', confirmed: false, stage: 'read_token', appId,
        });
      }

      if (!newToken || typeof newToken !== 'string') {
        throw new Error(
          'Discord لم يُرجع توكناً بعد محاولتين. ' +
          'تأكد من أن الحساب يدعم 2FA وأن TOTP Secret محفوظ، وأن التطبيق يحتوي على Bot.'
        );
      }
      tsLog('success', 'تم توليد توكن جديد بنجاح');
      // Save directly to persistent store so the token appears in Bot Tokens
      // even if the client-side save call fails (network blip, page close, etc.)
      try {
        const { name: reqName, icon: reqIcon } = req.body || {};
        const tkList = await readBotTokens();
        const tkFiltered = tkList.filter(t => t.appId !== appId);
        tkFiltered.unshift({
          appId, name: reqName || appId, icon: reqIcon || null,
          token: newToken, email, resetAt: Date.now(),
        });
        await writeBotTokens(tkFiltered);
      } catch (_) {}
      ok(res, { token: newToken, appId });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Bot Tokens persistent store ────────────────────────────────────────
  // Saves a record for every bot whose token has been revealed/reset.
  // Stored as an array of { appId, name, icon, token, resetAt, email }.

  app.get('/api/ts/bot-tokens', async (req, res) => {
    try {
      const list = await readBotTokens();
      ok(res, { tokens: list });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/ts/bot-tokens', async (req, res) => {
    try {
      const { appId, name, icon, token, email } = req.body || {};
      if (!appId || !token) return fail(res, new Error('appId and token are required'));
      const list = await readBotTokens();
      const filtered = list.filter(t => t.appId !== appId);
      filtered.unshift({ appId, name: name || appId, icon: icon || null, token, email: email || '', resetAt: Date.now() });
      await writeBotTokens(filtered);
      ok(res, { tokens: filtered });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/ts/bot-tokens/:appId', async (req, res) => {
    try {
      const appId = String(req.params.appId || '').trim();
      const list = await readBotTokens();
      const filtered = list.filter(t => t.appId !== appId);
      await writeBotTokens(filtered);
      ok(res, { tokens: filtered });
    } catch (e) { fail(res, e); }
  });

  // ── Reset-All background session (per-user) ──────────────────────────────
  // Runs entirely on the server so it continues even when the user navigates
  // away. Frontend monitors progress via SSE (ts_reset_all_progress / ts_reset_all_done).
  const _tsResetAllSessions = new Map();
  function tsResetAllSession() {
    const uid = currentUserId();
    if (!_tsResetAllSessions.has(uid)) {
      _tsResetAllSessions.set(uid, { state: 'idle', total: 0, done: 0, failed: 0, current: '', cancelRequested: false, errors: [], errorDetails: [] });
    }
    return _tsResetAllSessions.get(uid);
  }
  function pushResetAllEvent(type, extra = {}) {
    const s = tsResetAllSession();
    sseBroadcast(type, {
      resetAll: { state: s.state, total: s.total, done: s.done, failed: s.failed, remaining: Math.max(0, s.total - s.done - s.failed), current: s.current, errors: s.errors.slice(-10), errorDetails: (s.errorDetails || []).slice(-10) },
      _uid: currentUserId(),
      ...extra,
    });
  }

  app.get('/api/ts/reset-all/state', (req, res) => {
    const s = tsResetAllSession();
    ok(res, { state: s.state, total: s.total, done: s.done, failed: s.failed, remaining: Math.max(0, s.total - s.done - s.failed), current: s.current, errors: s.errors.slice(-10), errorDetails: (s.errorDetails || []).slice(-10) });
  });

  app.post('/api/ts/reset-all/stop', (req, res) => {
    const s = tsResetAllSession();
    s.cancelRequested = true;
    ok(res, { state: s.state });
  });

  app.post('/api/ts/reset-all/start', async (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const rawBots = Array.isArray(req.body?.bots) ? req.body.bots : [];
    const bots = rawBots.map(bot => ({
      id: String(bot?.id || '').trim(),
      name: String(bot?.name || bot?.id || '').trim().slice(0, 120),
      icon: bot?.icon || null,
    }));
    if (!email || !bots.length || bots.some(bot => !bot.id)) {
      return fail(res, new Error('email and bots[] are required'));
    }
    if (!tsFindAccount(email)) return fail(res, new Error('Account not found — save it first'));
    const s = tsResetAllSession();
    if (s.state === 'running') return fail(res, new Error('A reset-all is already running'));

    Object.assign(s, { state: 'running', total: bots.length, done: 0, failed: 0, current: '', cancelRequested: false, errors: [], errorDetails: [], lastError: null });
    pushResetAllEvent('ts_reset_all_progress');
    ok(res, { state: s.state, total: s.total });

    const uid = currentUserId();
    withUser(uid, async () => {
      try {
        await enqueueTsAccount(email, async () => {
          const acct = tsFindAccount(email);
          if (!acct) throw new Error('Account not found');
          const creds = tsDecryptAccount(acct);
          const { token, client } = await tsGetToken(email);
          const rateLimiter = makeTsRateLimiter('reset-all', null, { minimumGapMs: 900, account: email });
          const netOpts = {
            solveCaptcha: buildSolveCaptcha(), client,
            totpSecret: creds.totpSecret || undefined,
            password: creds.password || undefined,
            rateLimiter,
            captchaContext: 'reset-all',
          };
          const health = await ts.accountHealthProbe({ token, netOpts });
          if (!health.ready) throw new Error('فحص الجاهزية أوقف Reset All: ' + health.message);
          if (!client.devPortalLoaded) {
            await ts.simulateBrowsing({ token, netOpts });
            await ts.humanDelay(600, 1200);
            await ts.loadDevPortal({ client, token, netOpts });
          }
          const { apps: verifiedLibraryApps } = await loadCompleteTsApplicationLibrary({ token, netOpts });
          const verifiedBotIds = new Set(verifiedLibraryApps.filter(app => app?.bot?.id || app?.bot).map(app => String(app.id || '')));
          const missingBots = bots.filter(bot => !verifiedBotIds.has(bot.id));
          if (missingBots.length) {
            const err = new Error(`Reset All stopped: ${missingBots.length} bot(s) could not be confirmed in the complete library`);
            err.code = 'LIBRARY_INCOMPLETE';
            throw err;
          }
          for (let i = 0; i < bots.length; i++) {
            if (s.cancelRequested) break;
            const bot = bots[i];
            s.current = bot.name;
            pushResetAllEvent('ts_reset_all_progress');
            try {
              let mfaToken = null;
              if (creds.totpSecret) {
                try {
                  mfaToken = await ts.acquireMfa({ token, totpSecret: creds.totpSecret, netOpts });
                } catch (e) {
                  throw new Error(`تعذر تجهيز MFA قبل إعادة توكن ${bot.name || bot.id}: ${e?.message || e}`);
                }
                if (!mfaToken) throw new Error(`لم يتم تأكيد MFA قبل إعادة توكن ${bot.name || bot.id}`);
              }
              await ts.simulateResetTokenButtonClick({ client, token, appId: bot.id, netOpts });
              try {
                await ts.ensureBot({ token, appId: bot.id, netOpts });
                await ts.humanDelay(500, 900);
              } catch (e) {
                throw new Error(`تعذر تأكيد وجود البوت قبل إعادة التوكن: ${e?.message || e}`);
              }
              const newToken = await withTsRateRetry(`Reset token ${bot.name || bot.id}`, () =>
                ts.resetBotToken({ token, appId: bot.id, mfa: mfaToken, netOpts }),
                { attempts: 0, minWaitMs: 60_000, idempotent: false }
              );
              if (!newToken) throw new Error('No token returned');
              const list = await readBotTokens();
              const filtered = list.filter(t => t.appId !== bot.id);
              filtered.unshift({ appId: bot.id, name: bot.name, icon: bot.icon || null, token: newToken, email, resetAt: Date.now() });
              await writeBotTokens(filtered);
              s.done++;
              pushResetAllEvent('ts_reset_all_progress', { lastBot: { appId: bot.id, name: bot.name, icon: bot.icon || null, token: newToken } });
            } catch (e) {
              const message = e?.message || String(e);
              s.failed++;
              s.lastError = message;
              s.errors.push((bot.name || bot.id) + ': ' + message);
              if (!Array.isArray(s.errorDetails)) s.errorDetails = [];
              s.errorDetails.push({ appId: bot.id, name: bot.name || bot.id, message, code: e?.code || '', status: e?.status || 0 });
              tsLog('error', `${bot.name || bot.id}: فشل Reset All — ${message}`, { operation: 'reset_token', confirmed: false, appId: bot.id, stage: e?.stage || null });
              pushResetAllEvent('ts_reset_all_progress', { lastError: { appId: bot.id, name: bot.name || bot.id, message } });
            }
            if (i < bots.length - 1 && !s.cancelRequested) {
              await new Promise(r => setTimeout(r, 8000 + Math.floor(Math.random() * 10000)));
            }
          }
        }, { label: 'Reset all bot tokens' });
        s.state = s.cancelRequested ? 'cancelled' : 'done';
      } catch (e) {
        const message = e?.message || String(e);
        s.state = 'error';
        s.lastError = message;
        s.errors.push(message);
        if (!Array.isArray(s.errorDetails)) s.errorDetails = [];
        s.errorDetails.push({ scope: 'session', message, code: e?.code || '', status: e?.status || 0 });
      } finally {
        s.current = '';
        s.cancelRequested = false;
        pushResetAllEvent('ts_reset_all_done');
      }
    }).catch(() => {});
  });

  app.post('/api/ts/pause', (req, res) => {
    const s = tsSession();
    if (!['running', 'waiting', 'paused'].includes(s.state)) return ok(res, { snapshot: tsSnapshot() });
    s.pauseRequested = !s.pauseRequested;
    s.state = s.pauseRequested ? 'paused' : 'running';
    tsLog(s.pauseRequested ? 'warn' : 'info', s.pauseRequested ? 'تم إيقاف الجلسة مؤقتاً' : 'تم استئناف الجلسة');
    pushTsEvent('ts_progress');
    ok(res, { snapshot: tsSnapshot() });
  });

  app.post('/api/ts/stop', (req, res) => {
    const s = tsSession();
    if (s.state === 'idle' || s.state === 'done' || s.state === 'cancelled') {
      return ok(res, { snapshot: tsSnapshot() });
    }
    s.cancelRequested = true;
    s.pauseRequested = false;
    clearPendingTsCaptcha('Session stopped by user');
    s.waitUntilTs = 0;
    s.waitTotalMs = 0;
    s.current = '';
    tsLog('warn', 'تم طلب إيقاف الجلسة — سيتم إغلاق أي عملية معلقة بأقرب نقطة آمنة…');
    pushTsEvent('ts_progress');
    ok(res, { snapshot: tsSnapshot() });
  });

  app.post('/api/ts/clear-log', (req, res) => {
    const s = tsSession();
    s.log = [];
    pushTsEvent('ts_progress');
    ok(res, { snapshot: tsSnapshot() });
  });

  app.post('/api/ts/start', async (req, res) => {
    const s = tsSession();
    if (s.state === 'running' || s.state === 'waiting' || s.state === 'paused') {
      return fail(res, new Error('A session is already running'));
    }
    const { email, rules, count, prefix, waitMinutes, proxyUrl, speed, selectedTeamId, brightData } = req.body || {};
    const acct = tsFindAccount(email);
    if (!acct) return fail(res, new Error('Account not found — save it first'));
    const creds = tsDecryptAccount(acct);
    if (!creds.password && !creds.directToken) return fail(res, new Error('Saved account has no password and no direct token — re-save it'));

    const r = {
      createTeams: !!(rules && rules.createTeams),
      createBots:  !!(rules && rules.createBots),
      linkBots:    !!(rules && rules.linkBots),
    };
     if (r.linkBots && !r.createBots) {
       return fail(res, new Error('Link Bots requires Create Bots in the automation session'));
     }
    const n = Math.max(1, Math.min(50, parseInt(count) || 1));
    const wait = Math.max(0, Math.min(60, parseInt(waitMinutes) || 0));
    const pfx = String(prefix || 'Bot').slice(0, 24).trim() || 'Bot';
    const rawProxy = typeof proxyUrl === 'string' ? proxyUrl : '';
    const proxyList = rawProxy.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    const speedMap = { medium: 1.0, fast: 0.4, veryfast: 0.15, ultra: 0.05 };
    const speedFactor = speedMap[speed] != null ? speedMap[speed] : 1.0;
    const selTeamId = (typeof selectedTeamId === 'string' && selectedTeamId.trim()) ? selectedTeamId.trim() : null;

    // Validate Bright Data config if provided
    const wantsBrightData = !!(brightData && brightData.enabled);
    const bd = resolveBrightDataConfig(brightData, { useSavedPassword: true, useSavedFields: true });
    if (wantsBrightData && !bd) {
      return fail(res, new Error('Bright Data settings are incomplete — احفظ Customer ID/Username وZone وPassword أولاً'));
    }
    if (bd) {
      const preflight = await runBrightDataPreflight(bd, { testCount: 3 });
      if (!preflight.ok) {
        const firstTarget = preflight.failedTargets?.[0];
        const firstRotation = preflight.rotation?.checks?.find(c => !c.ok);
        const reason = firstTarget
          ? `${firstTarget.label}: ${firstTarget.error || 'failed'}`
          : firstRotation
            ? `rotation: ${firstRotation.error || 'failed'}`
            : 'unknown preflight failure';
        return fail(res, new Error('Bright Data preflight failed — ' + reason));
      }
    }

    // Reset session
    Object.assign(s, ts.makeSession());
    s.account = creds.email;
    s.rules = r;
    s.total = r.createBots ? n : 0;
    s.startedAt = Date.now();
    s.state = 'running';
    s.pauseRequested = false;
    s.log = [];
    const sessionConfig = { email: creds.email, rules: r, count: n, prefix: pfx, waitMinutes: wait, proxyUrl: rawProxy ? encrypt(rawProxy) : '', proxyUrlEncrypted: !!rawProxy, speed, selectedTeamId: selTeamId, brightData: bd ? { enabled: true, customerId: bd.customerId, zoneName: bd.zoneName, protocol: bd.protocol } : null, batchSize: Math.max(1, Math.min(5, parseInt(req.body?.batchSize) || 1)), sessionBudget: Math.max(0, Math.min(500, parseInt(req.body?.sessionBudget) || 0)) };
    const sessionData = ensureData();
    sessionData.tsLastSession = { state: 'running', config: sessionConfig, done: 0, failed: 0, startedAt: s.startedAt, updatedAt: Date.now() };
    writeData(sessionData);
    if (isTsAccountQueued(creds.email)) {
      s.state = 'waiting';
      s.current = 'Queued for account';
    }
    pushTsEvent('ts_progress');

    // Kick off in background but reply immediately
    const uid = currentUserId();
    ok(res, { snapshot: tsSnapshot() });

    const batchSize = Math.max(1, Math.min(5, parseInt(req.body?.batchSize) || 1));
    withUser(uid, () => enqueueTsAccount(creds.email, async () => {
      const ses = tsSession();
      if (!ses.cancelRequested) {
        ses.state = 'running';
        if (ses.current === 'Queued for account') ses.current = '';
        pushTsEvent('ts_progress');
      }
      const sessionBudget = Math.max(0, parseInt(req.body?.sessionBudget) || 0);
      return runTsSession({ creds, rules: r, count: n, prefix: pfx, waitMinutes: wait, proxyList, speedFactor, selectedTeamId: selTeamId, brightData: bd, batchSize, sessionBudget });
    }, { label: 'Create bots session' })
      .catch(e => {
        const ses = tsSession();
        ses.state = 'error';
        ses.lastError = e.message || String(e);
        tsLog('error', 'فشل الجلسة: ' + ses.lastError);
        pushTsEvent('ts_done');
      }));
  });

  // ── Bright Data URL builder ──────────────────────────────────────────────
  // Builds a correctly-formatted Bright Data proxy URL.
  // username = brd-customer-<CUSTOMER_ID>-zone-<ZONE_NAME>[-session-<SID>]
  // HTTP  → http://user:pass@brd.superproxy.io:33335
  // SOCKS5 → socks5h://user:pass@brd.superproxy.io:22228   (MUST use socks5h, not socks5)
  //
  // Per-bot IP rotation: pass a unique sessionId per bot → Bright Data pins that
  // session to ONE IP for its lifetime, so the bot creation sequence stays on a
  // single IP while the NEXT bot automatically gets a different one.
  // Without sessionId the proxy is "truly rotating" (new IP on every request).
  function buildBrightDataUrl(bd, sessionId) {
    bd = resolveBrightDataConfig(bd, { useSavedPassword: false, useSavedFields: false }) || bd;
    const host  = 'brd.superproxy.io';
    const sid   = sessionId ? ('-session-' + String(sessionId).replace(/[^a-z0-9_-]/gi, '')) : '';
    const user  = encodeURIComponent(`brd-customer-${bd.customerId}-zone-${bd.zoneName}${sid}`);
    const pass  = encodeURIComponent(bd.zonePassword);
    if (bd.protocol === 'socks5h') {
      return `socks5h://${user}:${pass}@${host}:22228`;
    }
    return `http://${user}:${pass}@${host}:33335`;
  }

  async function runTsSession({ creds, rules, count, prefix, waitMinutes, proxyList = [], speedFactor = 1.0, selectedTeamId, brightData: bd = null, batchSize: requestedBatchSize = 1, sessionBudget = 0 }) {
    const s = tsSession();
    try {
      // Reuse the token + warmed client cached by Test/verify so cookies and
      // X-Fingerprint persist across the whole session — this is what a real
      // browser does and dramatically reduces Discord's automation suspicion.
      let token, userId = null, client;
      const cached = tsCachedToken(creds.email);
      if (cached?.token && cached?.client) {
        token = cached.token;
        client = cached.client;
        tsLog('info', 'استخدام جلسة دخول محفوظة لـ ' + creds.email + ' (الكوكيز محفوظة)');
      } else if (creds.directToken) {
        token = creds.directToken;
        // For Bright Data: use a fixed session so the warm-up stays on one IP.
        const loginProxy = bd ? buildBrightDataUrl(bd, 'login') : (proxyList[0] || null);
        client = ts.createClient(loginProxy);
        if (bd)         tsLog('info', 'الجلسة عبر Bright Data — ' + (bd.protocol === 'socks5h' ? 'SOCKS5h' : 'HTTP') + ' · Zone: ' + bd.zoneName);
        else if (loginProxy) tsLog('info', 'الجلسة تمر عبر Proxy: ' + loginProxy.replace(/:[^:@]+@/, ':***@'));
        tsLog('info', 'استخدام التوكن المباشر — جاري تسخين الجلسة…');
        let warmed = false;
        try {
          await ts.warmUpClient(client);
          warmed = true;
        } catch (e) {
          tsLog('warn', 'تعذر تسخين الجلسة: ' + (e.message || e), { operation: 'warmup', confirmed: false });
        }
        if (!warmed) throw new Error('تعذر تجهيز جلسة التوكن المباشر');
        tsStoreToken(creds.email, token, client);
        tsLog('info', 'جلسة التوكن المباشر جاهزة بعد التحقق', { operation: 'warmup', confirmed: true });
      } else {
        tsLog('info', 'جاري تسجيل الدخول إلى ' + creds.email + '…');
        const loginProxy = bd ? buildBrightDataUrl(bd, 'login') : (proxyList[0] || null);
        client = ts.createClient(loginProxy);
        if (bd)         tsLog('info', 'الجلسة عبر Bright Data — ' + (bd.protocol === 'socks5h' ? 'SOCKS5h' : 'HTTP') + ' · Zone: ' + bd.zoneName);
        else if (loginProxy) tsLog('info', 'الجلسة تمر عبر Proxy: ' + loginProxy.replace(/:[^:@]+@/, ':***@'));
        const loginNetOpts = { solveCaptcha: buildSolveCaptcha(), client, speedFactor };
        const r = await ts.login({ email: creds.email, password: creds.password, totpSecret: creds.totpSecret, netOpts: loginNetOpts });
        token = r.token;
        userId = r.userId;
        tsStoreToken(creds.email, token, client);
        tsLog('success', 'تم تسجيل الدخول بنجاح' + (userId ? ' (uid ' + userId + ')' : ''));
      }
      let rateLimiter = makeTsRateLimiter('bot-create', null, { minimumGapMs: 800, account: creds.email });
      // Build netOpts ONCE per session, carrying the warmed client + speedFactor.
      let netOpts = {
        solveCaptcha: buildSolveCaptcha(),
        client,
        totpSecret: creds.totpSecret || undefined,
        password: creds.password || undefined,
        speedFactor,
        rateLimiter,
        captchaContext: 'bot-create',
      };
      const health = await ts.accountHealthProbe({ token, netOpts });
      if (!health.ready) {
        throw new Error('فحص الجاهزية أوقف التنفيذ: ' + health.message);
      }
      // Cached/direct-token sessions do not always carry the Discord user id.
      // Resolve it before team ownership checks; otherwise linkBots can silently
      // conclude that the user owns no teams and create unlinked applications.
      if (!userId) {
        try {
          const me = await ts.getCurrentUser({ token, netOpts });
          userId = me?.id || null;
        } catch (_) {}
      }
      s.currentUserId = userId || null;
      tsLog('success', 'فحص الحساب OK — لا يوجد rate-limit/حظر ظاهر قبل البدء', { operation: 'account_health', confirmed: true, stage: 'complete' });
      if (bd) tsLog('info', 'Bright Data IP rotation: كل بوت يستخدم session ID مستقل ضمن إعداد الاتصال (Zone: ' + bd.zoneName + ')');
      else if (proxyList.length > 1) tsLog('info', 'قائمة Proxy: ' + proxyList.length + ' عنوان — يتغير IP تلقائياً مع كل بوت');
      else if (proxyList.length === 1) tsLog('info', 'Proxy ثابت: ' + proxyList[0].replace(/:[^:@]+@/, ':***@'));

      const LONG_CREATE_REFRESH_MS = 4 * 60 * 1000;
      // Per-bot hard timeout — counts only "non-captcha" time.
      // Captcha solving (manual or automated) is paused from this counter so
      // a genuine captcha doesn't trigger a false timeout.
       // Axios HTTP timeout = 32s, rate-limit back-off up to ~4×30s = 120s worst
       // case, but _req retries have their own waits.  500s gives slower
       // operations (login, browse, createApplication, ensureBot, resetBotToken)
       // enough time to complete without a captcha.
       const BOT_CREATION_TIMEOUT_MS = 500_000;

      // ── Account-switching pool ───────────────────────────────────────────
      // Tracks the currently active TS account email (may change on rate limit).
      let currentEmail = (creds.email || '').toLowerCase();
      let botsThisAccount = 0; // session-budget: bots created on the current account
      // accountPaused[email] remains numeric internally; setTsAccountCooldown stores the reason separately.
      // Share reference with s.pausedAccounts so tsSnapshot() always sees live data.
      const accountPaused = s.pausedAccounts;
      if (!Object.prototype.hasOwnProperty.call(accountPaused, currentEmail)) accountPaused[currentEmail] = 0;

      // Build pool: primary account first, then all other saved TS accounts.
      const _poolRaw = tsAccountsRaw();
      const accountPool = [creds];
      for (const _a of _poolRaw) {
        const _ae = (_a.email || '').toLowerCase();
        if (_ae && _ae !== currentEmail) {
          try {
            const _dec = tsDecryptAccount(_a);
            if (_dec.directToken || _dec.password) accountPool.push(_dec);
          } catch (_) {}
        }
      }

      // Login/warm-up a single account and return its ctx object.
      // Reuses already-cached tokens (tsCachedToken).
      async function buildAccountCtx(acct) {
        const _email = (acct.email || '').toLowerCase();
        let _token, _client;
        const _cached = tsCachedToken(_email);
        if (_cached?.token && _cached?.client) {
          _token = _cached.token; _client = _cached.client;
          tsLog('info', `جلسة محفوظة لـ ${_email}`);
        } else if (acct.directToken) {
          _token = acct.directToken;
          const _lp = bd ? buildBrightDataUrl(bd, 'login') : (proxyList[0] || null);
          _client = ts.createClient(_lp);
          tsLog('info', `${_email}: تسخين جلسة التوكن المباشر…`);
          let _warmed = false;
          try {
            await ts.warmUpClient(_client);
            _warmed = true;
          } catch (_e) {
            tsLog('warn', `${_email}: تعذر تسخين الجلسة: ` + (_e.message || _e), { operation: 'warmup', confirmed: false });
          }
          if (!_warmed) throw new Error(`${_email}: تعذر تجهيز جلسة التوكن المباشر`);
          tsStoreToken(_email, _token, _client);
        } else if (acct.password) {
          tsLog('info', `${_email}: تسجيل دخول…`);
          const _lp = bd ? buildBrightDataUrl(bd, 'login') : (proxyList[0] || null);
          _client = ts.createClient(_lp);
          const _r = await ts.login({ email: _email, password: acct.password, totpSecret: acct.totpSecret, netOpts: { solveCaptcha: buildSolveCaptcha(), client: _client, speedFactor } });
          _token = _r.token;
          tsStoreToken(_email, _token, _client);
          tsLog('success', `${_email}: دخول ناجح`);
        } else {
          throw new Error(`${_email}: لا يوجد توكن أو كلمة مرور`);
        }
        const _rl = makeTsRateLimiter('bot-create', null, { minimumGapMs: 800, account: _email });
        const _no = {
          solveCaptcha: buildSolveCaptcha(),
          client: _client,
          totpSecret: acct.totpSecret || undefined,
          password: acct.password || undefined,
          speedFactor,
          rateLimiter: _rl,
          captchaContext: 'bot-create',
        };
        let _mfa = null;
        if (acct.totpSecret) {
          try { _mfa = await ts.acquireMfa({ token: _token, totpSecret: acct.totpSecret, netOpts: _no }); } catch (_e) {}
        }
        return { email: _email, token: _token, client: _client, mfaToken: _mfa, netOpts: _no, rateLimiter: _rl, creds: acct };
      }

      // Format seconds into a human-readable countdown string (2m 15s, 45s, etc.)
      function _fmtCountdown(sec) {
        if (sec <= 0) return '0s';
        const m = Math.floor(sec / 60), s = sec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
      }

      // Wrap a bot-creation promise with a smart timeout.
      //
      // The countdown PAUSES while s.pendingCaptcha is set (captcha solving is
      // outside our control and can legitimately take several minutes).
      // It also pauses while s.state === 'waiting' (e.g. the 60s no-account wait),
      // so inter-bot waits set by the caller don't count against this budget.
      //
      // Only "dead" time — when the session is running but nothing is happening —
      // counts toward BOT_CREATION_TIMEOUT_MS.
      function _withBotTimeout(promise, botName) {
        return new Promise((resolve, reject) => {
          let done = false;
          let elapsedMs = 0;              // accumulated non-paused time
          let lastTickAt = Date.now();
          let captchaPauseLogged = false;

          const tick = () => {
            if (done) return;
            const now = Date.now();
            const isCaptcha = !!s.pendingCaptcha;
            const isWaiting = s.state === 'waiting';
            const paused    = isCaptcha || isWaiting;

            if (!paused) {
              elapsedMs += now - lastTickAt;
            } else if (isCaptcha && !captchaPauseLogged) {
              captchaPauseLogged = true;
              tsLog('info', `[CAPTCHA] "${botName}": كابتشا معلّق — العداد متوقف`);
            } else if (!isCaptcha && captchaPauseLogged) {
              captchaPauseLogged = false;
              tsLog('info', `[CAPTCHA] "${botName}": الكابتشا اكتمل — استئناف العداد (${Math.round(elapsedMs / 1000)}s مستهلَكة)`);
            }

            lastTickAt = now;

            if (elapsedMs >= BOT_CREATION_TIMEOUT_MS) {
              done = true;
              reject(Object.assign(
                new Error(`[TIMEOUT] "${botName}" تجاوز ${Math.round(BOT_CREATION_TIMEOUT_MS / 1000)}s من الوقت الفعلي`),
                { code: 'OP_TIMEOUT' }
              ));
              return;
            }
            t = setTimeout(tick, 1000);
          };

          let t = setTimeout(tick, 1000);
          promise.then(
            v => { done = true; clearTimeout(t); resolve(v); },
            e => { done = true; clearTimeout(t); reject(e); }
          );
        });
      }

      // Find and activate the next available (non-rate-limited) account.
      // Reassigns the outer-scope: token, client, mfaToken, netOpts, rateLimiter, currentEmail.
      // Returns true on success, false if no usable account found.
      async function switchToNextAccount() {
        const _now = Date.now();
        for (const _acct of accountPool) {
          const _ae = (_acct.email || '').toLowerCase();
          if (_ae === currentEmail) continue;
          const _pausedUntil = tsAccountPauseUntil(s, _ae);
          if (_pausedUntil > _now) {
            const _remSec = Math.ceil((_pausedUntil - _now) / 1000);
            const _pauseMeta = s.pausedAccountMeta?.[_ae];
            tsLog('info', `${_ae}: متوقف مؤقتاً — ${_fmtCountdown(_remSec)} — ${_pauseMeta?.classification || 'cooldown'} — تخطّي`, {
              operation: 'account_switch', confirmed: false, classification: _pauseMeta?.classification || 'cooldown', retryAfterMs: _pausedUntil - _now,
            });
            continue;
          }
          try {
            tsLog('info', `جاري التبديل إلى: ${_ae} — فحص الحساب…`);
            const _ctx = await buildAccountCtx(_acct);
            const _h = await ts.accountHealthProbe({ token: _ctx.token, netOpts: _ctx.netOpts });
            if (!_h.ready) {
              const invalid = _h.classification === 'invalid_token' || _h.checks?.some(c => c.status === 401);
              const pauseMs = invalid ? 15 * 60 * 1000 : 2 * 60 * 1000;
              if (invalid) tsClearToken(_ae);
              tsLog('warn', `${_ae}: الحساب غير جاهز (${_h.message}) — متوقف ${invalid ? 'بسبب توكن منتهٍ' : 'مؤقتاً'}`, {
                operation: 'account_health', confirmed: false, classification: _h.classification,
              });
              setTsAccountCooldown(s, _ae, _now + pauseMs, invalid ? 'invalid_token' : (_h.classification || 'rate_limited'), _h.message, {
                retryAfterMs: _h.retryAfter || _h.resetAfter || pauseMs,
              });
              pushTsEvent('ts_progress');
              continue;
            }
            // Prepare the candidate session fully before committing the switch.
            // A valid /users/@me response alone is not enough to continue a
            // developer-portal operation.
            let portalReady = false;
            try {
              _ctx.client.devPortalLoaded = false;
              await ts.simulateBrowsing({ token: _ctx.token, netOpts: _ctx.netOpts });
              await ts.humanDelay(1000, 2000, speedFactor);
              await ts.loadDevPortal({ client: _ctx.client, token: _ctx.token, netOpts: _ctx.netOpts });
              portalReady = true;
            } catch (_e) {
              tsLog('warn', `تعذر تحضير Portal على ${_ae}: ` + (_e.message || _e), { operation: 'account_switch', confirmed: false });
              setTsAccountCooldown(s, _ae, Date.now() + 2 * 60 * 1000, 'portal_failed', _e.message || 'Developer Portal preparation failed', { retryAfterMs: 2 * 60 * 1000 });
            }
            if (!portalReady) continue;

            // Commit only after account health and portal readiness both pass.
            token = _ctx.token; client = _ctx.client; mfaToken = _ctx.mfaToken;
            netOpts = _ctx.netOpts; rateLimiter = _ctx.rateLimiter; currentEmail = _ctx.email;
            try {
              const _me = await ts.getCurrentUser({ token, netOpts });
              s.currentUserId = _me?.id || null;
            } catch (_) { s.currentUserId = null; }
            s.account = currentEmail;
            botsThisAccount = 0; // reset budget counter on every account switch
            tsLog('info', `تم التبديل إلى ${currentEmail} بعد فحص الحساب وتجهيز Portal`, { operation: 'account_switch', confirmed: true });
            pushTsEvent('ts_progress');
            return true;
          } catch (_e) {
            tsLog('warn', `فشل التبديل إلى ${_ae}: ` + (_e.message || _e));
            setTsAccountCooldown(s, _ae, _now + 2 * 60 * 1000, 'portal_failed', _e.message || 'Account switch failed', { retryAfterMs: 2 * 60 * 1000 });
            pushTsEvent('ts_progress');
          }
        }
        return false; // no available account
      }
      // ────────────────────────────────────────────────────────────────────

      async function refreshDeveloperContext(reason) {
        if (s.cancelRequested) return false;
        tsLog('info', `تحديث جلسة Developer Portal بسبب: ${reason}`);
        let h;
        try {
          h = await ts.accountHealthProbe({ token, netOpts });
          if (!h.ready) {
            tsLog('warn', 'فحص الحساب بعد التحديث لم ينجح: ' + h.message, {
              operation: 'portal_refresh', confirmed: false, classification: h.classification,
            });
            return false;
          }
        } catch (e) {
          tsLog('warn', 'فشل فحص الحساب أثناء تحديث الجلسة: ' + (e.message || e), { operation: 'portal_refresh', confirmed: false });
          return false;
        }
        try {
          client.devPortalLoaded = false;
          await ts.simulateBrowsing({ token, netOpts });
          await ts.humanDelay(900, 1800, speedFactor);
          await ts.loadDevPortal({ client, token, netOpts });
          tsLog('success', 'تم تحديث Developer Portal — الاستئناف من آخر رقم محفوظ', { operation: 'portal_refresh', confirmed: true });
          return true;
        } catch (e) {
          tsLog('warn', 'تعذر تحديث Developer Portal: ' + (e.message || e), { operation: 'portal_refresh', confirmed: false });
          return false;
        }
      }

      // Behavioural warm-up — once per cached client.
      if (!client.devPortalLoaded) {
        try {
          tsLog('info', 'محاكاة تصفح طبيعي بعد الدخول…');
          await ts.simulateBrowsing({ token, netOpts });
          await ts.humanDelay(2500, 6000, speedFactor);
          tsLog('info', 'فتح Developer Portal…');
          await ts.loadDevPortal({ client, token, netOpts });
        } catch (e) {
          tsLog('warn', 'تعذر إكمال محاكاة التصفح: ' + (e.message || String(e)));
        }
      }

      // Acquire MFA token once per session (sensitive endpoints need it).
      let mfaToken = null;
      if (creds.totpSecret) {
        try {
          mfaToken = await ts.acquireMfa({ token, totpSecret: creds.totpSecret, netOpts });
          if (mfaToken) tsLog('info', 'تم الحصول على رمز MFA للعمليات الحساسة');
          else tsLog('warn', 'تخطي رمز MFA — العمليات الحساسة قد تفشل');
        } catch (e) {
          tsLog('warn', 'تعذر الحصول على رمز MFA: ' + (e.message || String(e)));
        }
      } else {
        tsLog('info', 'الحساب بدون 2FA — تخطي خطوة MFA');
      }

      // ─────────────────────────────────────────────────────────
      // 1) Team setup — create new team OR load existing teams
      // ─────────────────────────────────────────────────────────
      let teamId = null;
      let availableTeams = []; // [{id, name, appCount}] for rotation
      const teamAppCounts  = {}; // teamId → apps currently used by this session/account
      const loadTeamCounts = async (teams) => Promise.all((teams || []).map(async t => {
        let appCount = Array.isArray(t.apps) ? t.apps.length : 0;
        try {
          const apps = await ts.listTeamApplications({ token, teamId: t.id, netOpts });
          if (Array.isArray(apps)) appCount = apps.length;
        } catch (_) {}
        return { ...t, appCount };
      }));

      if (rules.createTeams) {
        if (s.cancelRequested) return finalizeTs();
        const teamName = prefix.length >= 2 ? prefix : (prefix + '-Team');
        await ts.navigateTo({ client, page: 'https://discord.com/developers/teams' });
        await ts.humanDelay(700, 1800, speedFactor);
        // Fetch existing teams so we can include them in rotation if the new one fills up
         let existingTeams = [];
         try {
           const listedTeams = await ts.listTeams({ token, netOpts });
           // Transfer requires ownership; member teams must not be offered as
           // rotation targets because they will fail later and waste a bot.
           const ownedTeams = listedTeams.filter(t =>
             t && (t.owner_user_id === s.currentUserId || t.isOwner === true)
           );
           existingTeams = await loadTeamCounts(ownedTeams);
         } catch (_) {}
        await ts.humanDelay(900, 2200, speedFactor);
        tsLog('info', 'إنشاء تيم جديد: ' + teamName);
        const team = await ts.createTeam({ token, name: teamName, netOpts });
        s.teamId = teamId = team.id;
        s.teamName = team.name;
        teamAppCounts[team.id] = 0;
        tsLog('success', 'تم إنشاء التيم #' + team.id);
        // Include existing teams in rotation (after the new one)
        availableTeams = [{ id: team.id, name: team.name, appCount: 0 }, ...existingTeams.filter(t => t.id !== team.id).map(t => ({ id: t.id, name: t.name, appCount: t.appCount || 0 }))];
        for (const existing of existingTeams) teamAppCounts[existing.id] = existing.appCount || 0;
        await ts.navigateTo({ client, page: `https://discord.com/developers/teams/${team.id}` });
        await ts.humanDelay(1200, 2800, speedFactor);
        pushTsEvent('ts_progress');
      } else if (rules.linkBots) {
        // Load available teams for rotation
        try {
          await ts.navigateTo({ client, page: 'https://discord.com/developers/teams' });
          await ts.humanDelay(600, 1400, speedFactor);
           const teams = await ts.listTeams({ token, netOpts });
           const ownedTeams = teams.filter(t =>
             t && (t.owner_user_id === s.currentUserId || t.isOwner === true)
           );
           const countedTeams = await loadTeamCounts(ownedTeams);
           availableTeams = countedTeams.map(t => ({ id: t.id, name: t.name, appCount: t.appCount || 0 }));
           for (const team of availableTeams) teamAppCounts[team.id] = team.appCount;
          if (availableTeams.length) {
            // Use selectedTeamId if provided and valid, otherwise pick first
            const preferred = selectedTeamId ? availableTeams.find(t => t.id === selectedTeamId) : null;
            const picked = preferred || availableTeams[0];
            s.teamId = teamId = picked.id;
            s.teamName = picked.name;
            tsLog('info', 'سيتم الربط مع تيم موجود: ' + picked.name + ' (' + (picked.appCount || 0) + '/25 تطبيق)');
          } else {
            tsLog('warn', 'لا يوجد تيم متاح للربط — سيتم إنشاء البوتات بدون تيم');
          }
        } catch (e) { tsLog('warn', 'تعذر جلب التيمات: ' + e.message); }
      }

      // ─────────────────────────────────────────────────────────
      // 2) Create bots (optional)
      // ─────────────────────────────────────────────────────────
      if (rules.createBots) {
        const d = ensureData();
        await ts.navigateTo({ client, page: 'https://discord.com/developers/applications' });
        await ts.humanDelay(700, 1500, speedFactor);
        try { await ts.listApplications({ token, netOpts }); } catch (_) {}
        await ts.humanDelay(800, 1800, speedFactor);

        // ── Parallel batch mode ─────────────────────────────────────────────
        // With IP rotation (Bright Data or proxy list > 1):
        //   Each bot creation runs on a DIFFERENT IP, so concurrent creation
        //   doesn't look like one human navigating — human delays are removed.
        //
        // Without IP rotation (or batchSize=1):
        //   Old sequential behaviour — one bot at a time with natural delays.
        //
        // Discord rate limit: 50 req/sec per token.
        // Worst case: 5 bots × 3 calls = 15 concurrent requests — well within limit.
        const hasIpRotation = !!(bd || proxyList.length > 1);
        const effectiveBatch = hasIpRotation ? Math.max(1, Math.min(5, requestedBatchSize)) : 1;
        const useParallelMode = effectiveBatch > 1;

        if (useParallelMode) {
          tsLog('info', 'وضع الدُّفعات المتوازية: ' + effectiveBatch + ' بوت في نفس الوقت — التأخيرات البشرية محذوفة');
        }

        // Creates ONE bot application + bot user + token.
        // Designed to be called concurrently; each invocation uses its own
        // proxy-cloned client so requests exit from a unique IP.
        const createOneBotAsync = async (botIndex, num, name, teamIdForBot) => {
          const _botStartedAt = Date.now();
          let stage = 'prepare';
          let appPayload = null;
          let botToken = null;
          let botClient = client;
          try {
          let botNetOpts = netOpts;
          if (bd) {
            const sessionId = 'bot' + num + '_' + Math.random().toString(36).slice(2, 8);
            const bdProxy = buildBrightDataUrl(bd, sessionId);
            botClient = ts.cloneClientWithProxy(client, bdProxy);
            botNetOpts = { ...netOpts, client: botClient };
          } else if (proxyList.length > 1) {
            const botProxy = proxyList[botIndex % proxyList.length];
            botClient = ts.cloneClientWithProxy(client, botProxy);
            botNetOpts = { ...netOpts, client: botClient };
          }

          // In parallel mode every bot exits from a different IP — no need to
          // mimic a single human's pace between page navigations.
          const pause = (min, max) => useParallelMode
            ? Promise.resolve()
            : ts.humanDelay(min, max, speedFactor);

          const linkAtCreation = rules.linkBots && teamIdForBot;
          stage = 'create_application';
          appPayload = await ts.createApplication({
            token, name,
            teamId: linkAtCreation ? teamIdForBot : null,
            netOpts: botNetOpts,
          });
          if (linkAtCreation) {
            stage = 'verify_team_link';
            const linkedTeamId = appPayload?.team?.id || appPayload?.team_id || null;
            const confirmedTeamId = linkedTeamId || (await ts.getApplication({ token, appId: appPayload.id, netOpts: botNetOpts }))?.team?.id || null;
            if (String(confirmedTeamId || '') !== String(teamIdForBot)) {
              throw Object.assign(new Error('Application was created but team linking was not confirmed'), {
                code: 'BOT_PARTIAL', tsStage: 'verify_team_link',
              });
            }
          }

          // Update Referer chain on the bot's own client (no HTTP /track needed)
          botClient.currentPage = `https://discord.com/developers/applications/${appPayload.id}/information`;
          if (botClient === client) client.currentPage = botClient.currentPage;
          await pause(800, 1800);

          botClient.currentPage = `https://discord.com/developers/applications/${appPayload.id}/bot`;
          if (botClient === client) client.currentPage = botClient.currentPage;
          await pause(600, 1400);

          stage = 'ensure_bot';
          const ensured = await ts.ensureBot({ token, appId: appPayload.id, netOpts: botNetOpts });
          const ensuredBotId = ensured?.id || ensured?.bot?.id || appPayload.bot?.id || null;
          if (!ensuredBotId) {
            throw Object.assign(new Error('Bot user was not confirmed after creation'), { code: 'BOT_NOT_VERIFIED' });
          }
          appPayload = {
            ...appPayload,
            bot: appPayload.bot || (ensured?.id ? ensured : ensured?.bot) || { id: ensuredBotId },
          };
          await pause(800, 1800);

          stage = 'reset_token';
          botToken = await ts.resetBotToken({ token, appId: appPayload.id, mfa: mfaToken, netOpts: botNetOpts });
          if (!botToken || typeof botToken !== 'string' || botToken.length < 20) {
            throw new Error('Discord did not return a usable bot token');
          }

          const savedPfp = tsPfpSettings();
          if (savedPfp.avatar || savedPfp.banner) {
            stage = 'apply_identity';
            let botPfpOk = false;
            let appPfpOk = false;
            try {
              await ts.updateBotProfileViaOwner({
                token,
                appId: appPayload.id,
                avatar: savedPfp.avatar || undefined,
                banner: savedPfp.banner || undefined,
                netOpts: botNetOpts,
              });
              botPfpOk = true;
            } catch (e) {
              tsLog('warn', 'تعذر تطبيق Pfp من حساب المالك على ' + name + ': ' + (e.message || e));
            }
            try {
              await ts.updateAppVisuals({
                token,
                appId: appPayload.id,
                icon: savedPfp.avatar || undefined,
                coverImage: savedPfp.banner || undefined,
                netOpts: botNetOpts,
              });
              appPfpOk = true;
            } catch (e) {
              tsLog('warn', 'تعذر تطبيق صورة التطبيق/البنر على ' + name + ': ' + (e.message || e));
            }
            if (!botPfpOk && savedPfp.avatar) {
              try {
                await ts.updateBotProfile({ botToken, avatar: savedPfp.avatar || undefined, netOpts: botNetOpts });
                botPfpOk = true;
              } catch (e) {
                tsLog('warn', 'تعذر تطبيق Avatar عبر توكن البوت على ' + name + ': ' + (e.message || e));
              }
            }
            if (botPfpOk && appPfpOk) {
              tsLog('success', 'تم تطبيق Pfp/Visuals المحفوظة على ' + name);
            } else {
              throw Object.assign(new Error('Identity update was only partially confirmed'), {
                code: 'BOT_PARTIAL',
                tsStage: 'apply_identity',
              });
            }
          }

          // Auto-intents: if the setting is on, enable all 3 Privileged Intents right after creation
          if (!!(ensureData().tsAutoIntents)) {
            stage = 'apply_intents';
            try {
              const intentResult = await ts.setApplicationIntents({ token, appId: appPayload.id, enabled: true, netOpts: botNetOpts, app: appPayload });
              if (intentResult?.operation?.confirmed === false) {
                throw new Error(intentResult.operation.approvedRemain
                  ? 'Approved intents remain unchanged'
                  : 'Intent state was not confirmed');
              }
              tsLog('success', 'تم تفعيل Intents تلقائياً على ' + name, { operation: 'apply_intents', appId: appPayload.id, confirmed: true });
            } catch (e) {
              throw Object.assign(new Error('Auto Intents were not confirmed: ' + (e.message || e)), {
                code: 'BOT_PARTIAL',
                tsStage: 'apply_intents',
              });
            }
          }

          if (rules.linkBots && teamIdForBot && !linkAtCreation) {
            stage = 'transfer_to_team';
            await pause(1200, 2400);
            await ts.transferAppToTeam({ token, appId: appPayload.id, teamId: teamIdForBot, mfa: mfaToken, netOpts: botNetOpts });
          }

          const durationMs = Date.now() - _botStartedAt;
          return { appPayload, botToken, durationMs };
          } catch (error) {
            error.tsStage = error.tsStage || stage;
            error.tsAppId = error.tsAppId || appPayload?.id || null;
            error.tsAppPayload = error.tsAppPayload || appPayload || null;
            error.tsBotToken = error.tsBotToken || botToken || null;
            error.tsPartial = error.tsPartial || !!appPayload;
            throw error;
          }
        };

        // ── Main batch loop ──────────────────────────────────────────────────
        let i = 0;
        while (i < count) {
          if (s.cancelRequested) break;
          if (!(await waitIfPaused())) break;

          // Team rotation — evaluated once per batch (sequential, before parallel work)
          if (rules.linkBots && teamId && (teamAppCounts[teamId] || 0) >= 25) {
            const nextTeam = availableTeams.find(t => t.id !== teamId && (teamAppCounts[t.id] || 0) < 25);
            if (nextTeam) {
              tsLog('info', 'التيم الحالي ممتلئ — التبديل إلى: ' + nextTeam.name);
              teamId = nextTeam.id;
              s.teamId = teamId;
              s.teamName = nextTeam.name;
              pushTsEvent('ts_progress');
            } else {
              tsLog('info', 'جميع التيمات ممتلئة — إنشاء تيم Studio جديد تلقائياً…');
              const studioName = ('Studio-' + String(Date.now()).slice(-6)).slice(0, 32);
              try {
                await ts.navigateTo({ client, page: 'https://discord.com/developers/teams' });
                await ts.humanDelay(600, 1400, speedFactor);
                const newTeam = await ts.createTeam({ token, name: studioName, netOpts });
                availableTeams.push({ id: newTeam.id, name: newTeam.name, appCount: 0 });
                teamAppCounts[newTeam.id] = 0;
                teamId = newTeam.id;
                s.teamId = teamId;
                s.teamName = newTeam.name;
                tsLog('success', 'تم إنشاء تيم Studio جديد: ' + newTeam.name + ' — جاري الاستمرار…', { operation: 'create_team', confirmed: true, stage: 'complete', teamId: newTeam.id });
                pushTsEvent('ts_progress');
              } catch (e) {
                tsLog('warn', 'تعذر إنشاء تيم Studio جديد: ' + (e.message || e) + ' — سيتم الإنشاء بدون تيم');
                teamId = null;
              }
            }
          }

          // Build batch slots — pre-allocate sequential numbers BEFORE any async work
          // so that concurrent bots never generate duplicate names.
          const batchEnd   = Math.min(i + effectiveBatch, count);
          const baseNum    = (d.tsLastNumber || 0);
          const batchSlots = [];
          for (let j = i; j < batchEnd; j++) {
            const num  = baseNum + (j - i) + 1;
            const name = (prefix + '-' + String(num).padStart(3, '0')).slice(0, 32);
            batchSlots.push({ botIndex: j, num, name });
          }

          // Commit the counter advance atomically (before launching parallel work)
          d.tsLastNumber = baseNum + batchSlots.length;
          writeData(d);
          const savedProgress = ensureData();
          savedProgress.tsLastSession = { ...(savedProgress.tsLastSession || {}), state: 'running', done: s.done, failed: s.failed, updatedAt: Date.now() };
          writeData(savedProgress);

          const teamIdSnapshot = teamId; // freeze — rotation only happens between batches

          if (useParallelMode) {
            tsLog('info', 'دُفعة: ' + batchSlots.map(b => b.name).join(' · '));
          } else {
            tsLog('info', 'إنشاء البوت: ' + batchSlots[0].name);
          }

          s.current = batchSlots.length === 1
            ? batchSlots[0].name
            : batchSlots.map(b => b.name).join(' + ');
          pushTsEvent('ts_progress');

          // Launch all bots in this batch concurrently.
          // Stagger starts by 200ms per slot so concurrent requests don't all
          // hit the same API bucket at the exact same millisecond — this is the
          // lightest possible rate-limit prevention: no extra delays for sequential
          // mode (effectiveBatch=1 → stagger=0), and negligible overhead for
          // parallel mode (max 800ms spread over 5 bots).
          const batchStartedAt = Date.now();
          const results = await Promise.allSettled(
            batchSlots.map((slot, _si) => {
              const _stagger = _si * 200;
              return (_stagger > 0 ? ts.humanDelay(_stagger, _stagger + 80, 1.0) : Promise.resolve())
                .then(() => _withBotTimeout(
                createOneBotAsync(slot.botIndex, slot.num, slot.name, teamIdSnapshot),
                slot.name
              ));
            })
          );
          const batchDurationMs = Date.now() - batchStartedAt;

          // Process results sequentially — JS is single-threaded here so no races
          let batchRateLimitHandled = false;
          for (let k = 0; k < results.length; k++) {
            const result = results[k];
            const slot   = batchSlots[k];

            if (result.status === 'fulfilled') {
              const { appPayload, botToken, durationMs } = result.value;
              s.bots.push({ name: slot.name, appId: appPayload.id, botUserId: appPayload.bot?.id || null, token: botToken });
              s.done += 1; botsThisAccount += 1;
              if (rules.linkBots && teamId) teamAppCounts[teamId] = (teamAppCounts[teamId] || 0) + 1;
              const durSec = durationMs ? (durationMs / 1000).toFixed(1) : null;
              const durLabel = durSec ? ` — ${durSec}s` : '';
              tsLog('success', 'تم: ' + slot.name + ' · token=' + botToken.slice(0, 12) + '…' + durLabel, { durationMs, appId: appPayload.id, botName: slot.name, operation: 'create_bot', confirmed: true, stage: 'complete' });
              try {
                const tkList = await readBotTokens();
                const tkFiltered = tkList.filter(t => t.appId !== appPayload.id);
                tkFiltered.unshift({
                  appId: appPayload.id, name: slot.name,
                  icon: appPayload.icon || null,
                  token: botToken,
                  email: creds.email || '',
                  resetAt: Date.now(),
                  createdAt: Date.now(),
                });
                await writeBotTokens(tkFiltered);
              } catch (_) {}
              pushTsEvent('ts_bot_created', { bot: { name: slot.name, appId: appPayload.id, hasToken: true, durationMs } });
            } else {
              const err = result.reason;
              const msg = err?.message || String(err);
              s.failed += 1;
              tsLog('error', 'فشل ' + slot.name + ': ' + msg, {
                operation: 'create_bot',
                stage: err?.tsStage || null,
                appId: err?.tsAppId || null,
                confirmed: false,
              });
              // A created application must never be retried as a fresh create:
              // doing so would create a duplicate app. Keep any usable token,
              // but report the operation as incomplete and stop this slot.
              if (err?.tsPartial) {
                if (err.tsAppId && err.tsBotToken) {
                  try {
                    const partialTokens = await readBotTokens();
                    const filteredPartial = partialTokens.filter(t => t.appId !== err.tsAppId);
                    filteredPartial.unshift({
                      appId: err.tsAppId,
                      name: slot.name,
                      icon: err.tsAppPayload?.icon || null,
                      token: err.tsBotToken,
                      email: currentEmail || '',
                      resetAt: Date.now(),
                      createdAt: Date.now(),
                      incomplete: true,
                      incompleteStage: err.tsStage || 'unknown',
                    });
                    await writeBotTokens(filteredPartial);
                  } catch (persistErr) {
                    tsLog('error', `تعذر حفظ نتيجة ${slot.name} الجزئية: ${persistErr.message || persistErr}`, {
                      operation: 'persist_partial_bot', confirmed: false, appId: err.tsAppId,
                    });
                  }
                }
                tsLog('warn', `لم يُحتسب ${slot.name} كنجاح — العملية توقفت عند ${err.tsStage || 'مرحلة غير معروفة'}${err.tsAppId ? ` (App ID: ${err.tsAppId})` : ''}`, {
                  operation: 'create_bot', stage: err.tsStage || null, appId: err.tsAppId || null, confirmed: false, partial: true,
                });
                pushTsEvent('ts_bot_partial', {
                  bot: err.tsAppId ? { name: slot.name, appId: err.tsAppId, hasToken: !!err.tsBotToken, incomplete: true } : null,
                  error: msg,
                  stage: err.tsStage || null,
                });
                continue;
              }
               // A stop request must not trigger account switching, cooldowns,
               // or expensive retries after the user asked to end the session.
               if (s.cancelRequested) {
                 tsLog('warn', 'تم إلغاء إعادة المحاولة لـ ' + slot.name + ' بناءً على طلب الإيقاف');
                 continue;
               }

              // ── Classify the error ───────────────────────────────────────────
              // Hard block (60003): Discord blocks the specific operation without
              // a solvable MFA ticket — different from a real token-revoke 401.
              const _isHardBlock = err?.code === 60003 || err?.data?.code === 60003 ||
                                   /two.factor.is.required/i.test(msg);
              // Real 401: Discord revoked the session token entirely.
              const _isTokenRevoked = !_isHardBlock &&
                                      (err?.status === 401 || /Unauthorized/i.test(msg));
              const _isCritical  = _isHardBlock || _isTokenRevoked;
              const _isRateLimit = isRateLimitedError(err);
              const _isGlobalRateLimit = _isRateLimit && (
                err?.rateLimit?.global === true ||
                err?.data?.global === true ||
                String(err?.rateLimit?.scope || '').toLowerCase() === 'global'
              );
              const _isTimeout   = err?.code === 'OP_TIMEOUT';

              // ── Shared helper: switch account → FRESH SESSION → retry ──────────
              // After any error we don't do a "hot retry" on whatever state the
              // session is in.  Instead we:
              //   1. Switch to the next account (or rebuild current one if none left)
              //   2. Open a completely fresh portal context — navigate to the
              //      developer portal and list applications exactly like the session
              //      init does at the top of createBots.  This guarantees the new
              //      account starts from a known-clean state, not a leftover context
              //      that may already be flagged by Discord.
              //   3. Only then create the bot.
              const _switchAndRetry = async (reason) => {
                const switched = await switchToNextAccount();
                if (!switched) {
                  const blockedUntil = tsAccountPauseUntil(s, currentEmail);
                  if (blockedUntil > Date.now()) {
                    tsLog('error', `لا يوجد حساب آمن قابل للتبديل (${reason}) — لن نعيد المحاولة على ${currentEmail} أثناء الإيقاف`, {
                      operation: 'account_switch', confirmed: false, retryAfterMs: blockedUntil - Date.now(),
                    });
                    return false;
                  }
                  // No usable sibling account and current account is not paused:
                  // rebuild it once for transient session errors.
                  tsLog('warn', `لا يوجد حساب بديل (${reason}) — إعادة بناء الجلسة على ${currentEmail} من الصفر…`);
                  await tsSleep(15_000);
                  try {
                    const _rc = accountPool.find(a => (a.email || '').toLowerCase() === currentEmail) || creds;
                    const _fx = await buildAccountCtx(_rc);
                    token = _fx.token; client = _fx.client; mfaToken = _fx.mfaToken;
                    netOpts = _fx.netOpts; rateLimiter = _fx.rateLimiter;
                    tsLog('info', `أُعيد بناء جلسة الحساب ${currentEmail}`, { operation: 'session_rebuild', confirmed: true });
                  } catch (_re) {
                    tsLog('error', 'فشل إعادة بناء الجلسة: ' + (_re?.message || _re));
                    return false;
                  }
                }

                // ── Fresh portal context (step 2) ──────────────────────────────
                // Replicate the same warm-up that runs at the very start of the
                // createBots block so every retry begins from a clean slate.
                try {
                  tsLog('info', `جلسة جديدة على ${currentEmail} (${reason}) — تهيئة Developer Portal…`);
                  await ts.navigateTo({ client, page: 'https://discord.com/developers/applications' });
                  await ts.humanDelay(900, 1800, speedFactor);
                  try { await ts.listApplications({ token, netOpts }); } catch (_) {}
                  await ts.humanDelay(700, 1400, speedFactor);
                  tsLog('info', `Developer Portal جاهز على ${currentEmail} — بدء إنشاء ${slot.name}`);
                } catch (_fe) {
                  tsLog('warn', `تعذر تهيئة Portal (${reason}): ` + (_fe.message || _fe));
                }

                // ── Retry (step 3) ─────────────────────────────────────────────
                try {
                  const _rs = Date.now();
                  const { appPayload: rApp, botToken: rTok } = await _withBotTimeout(
                    createOneBotAsync(slot.botIndex, slot.num, slot.name, teamIdSnapshot),
                    slot.name
                  );
                  const rDurMs = Date.now() - _rs;
                  s.bots.push({ name: slot.name, appId: rApp.id, botUserId: rApp.bot?.id || null, token: rTok });
                  s.done += 1; s.failed -= 1; botsThisAccount += 1;
                  if (rules.linkBots && teamId) teamAppCounts[teamId] = (teamAppCounts[teamId] || 0) + 1;
                  tsLog('success', `تم (${reason}/${currentEmail}): ${slot.name} — ${(rDurMs/1000).toFixed(1)}s`, { durationMs: rDurMs, appId: rApp.id, botName: slot.name, operation: 'create_bot', confirmed: true, stage: 'complete' });
                  try {
                    const tkList = await readBotTokens();
                    const tkFiltered = tkList.filter(t => t.appId !== rApp.id);
                    tkFiltered.unshift({
                      appId: rApp.id, name: slot.name, icon: rApp.icon || null,
                      token: rTok, email: currentEmail || '',
                      resetAt: Date.now(), createdAt: Date.now(),
                    });
                    await writeBotTokens(tkFiltered);
                  } catch (_) {}
                  pushTsEvent('ts_bot_created', { bot: { name: slot.name, appId: rApp.id, hasToken: true, durationMs: rDurMs, isRetry: true } });
                  return true;
                } catch (re) {
                  tsLog('error', `فشل retry ${slot.name} (${reason}): ` + (re?.message || re));
                  return false;
                }
              };

              // ── 1) Timeout: restart full session, then retry ─────────────────
              if (_isTimeout) {
                tsLog('warn', `[TIMEOUT] ${slot.name}: تجاوز ${Math.round(BOT_CREATION_TIMEOUT_MS / 1000)}s — إعادة تشغيل الجلسة كاملاً…`);
                try {
                  const _restartCreds = accountPool.find(
                    a => (a.email || '').toLowerCase() === currentEmail
                  ) || creds;
                  tsLog('info', `إعادة تسجيل الدخول بـ ${currentEmail}…`);
                  const _freshCtx = await buildAccountCtx(_restartCreds);
                  token = _freshCtx.token; client = _freshCtx.client;
                  mfaToken = _freshCtx.mfaToken; netOpts = _freshCtx.netOpts;
                  rateLimiter = _freshCtx.rateLimiter;
                  tsLog('info', `الجلسة أُعيدت — إعادة إنشاء ${slot.name}…`, { operation: 'session_rebuild', confirmed: false, stage: 'rebuild' });
                  const _tStart = Date.now();
                  const { appPayload: tApp, botToken: tTok } = await _withBotTimeout(
                    createOneBotAsync(slot.botIndex, slot.num, slot.name, teamIdSnapshot),
                    slot.name
                  );
                  const tDurMs = Date.now() - _tStart;
                  s.bots.push({ name: slot.name, appId: tApp.id, botUserId: tApp.bot?.id || null, token: tTok });
                  s.done += 1; s.failed -= 1;
                  if (rules.linkBots && teamId) teamAppCounts[teamId] = (teamAppCounts[teamId] || 0) + 1;
                  tsLog('success', `تم (session-restart): ${slot.name} — ${(tDurMs/1000).toFixed(1)}s`, { durationMs: tDurMs, appId: tApp.id, operation: 'create_bot', confirmed: true, stage: 'complete' });
                  try {
                    const _tkList = await readBotTokens();
                    const _tkFiltered = _tkList.filter(t => t.appId !== tApp.id);
                    _tkFiltered.unshift({
                      appId: tApp.id, name: slot.name, icon: tApp.icon || null,
                      token: tTok, email: currentEmail || '',
                      resetAt: Date.now(), createdAt: Date.now(),
                    });
                    await writeBotTokens(_tkFiltered);
                  } catch (_) {}
                  pushTsEvent('ts_bot_created', {
                    bot: { name: slot.name, appId: tApp.id, hasToken: true, durationMs: tDurMs, isRetry: true },
                  });
                } catch (_te) {
                  // Session restart failed → escalate: switch to a different account
                  tsLog('error', `فشل بعد إعادة الجلسة لـ ${slot.name}: ` + (_te?.message || _te));
                  await _switchAndRetry('timeout-switch');
                }

              // ── 2) Critical (token revoked OR hard block 60003) ──────────────
              // In BOTH cases we pause the current account and switch immediately.
              // We never stop the loop — we always try the next account.
              } else if (_isCritical) {
                if (_isHardBlock) {
                  tsLog('warn', `حظر MFA (60003/Two-Factor) على ${slot.name} [${currentEmail}] — تبديل فوري للحساب…`);
                } else {
                  tsClearToken(currentEmail);
                  tsLog('warn', `تم إلغاء التوكن [${currentEmail}] — تبديل فوري للحساب…`);
                }
                // Pause this account for 15 minutes so switchToNextAccount skips it
                setTsAccountCooldown(s, currentEmail, Date.now() + 15 * 60 * 1000, _isHardBlock ? 'mfa_block' : 'invalid_token', _isHardBlock ? 'MFA hard block' : 'Token revoked', { retryAfterMs: 15 * 60 * 1000 });
                pushTsEvent('ts_progress');
                await _switchAndRetry(_isHardBlock ? 'hard-block' : 'token-revoked');

              // ── 3) Rate limit / Cloudflare ───────────────────────────────────
              } else if (_isRateLimit) {
                if (_isGlobalRateLimit) {
                  const globalWait = Math.max(retryAfterMs(err), 10_000);
                  s.lastError = `Global rate limit — paused for ${Math.ceil(globalWait / 1000)}s`;
                  tsLog('error', `global rate limit على ${currentEmail} — إيقاف الجلسة مؤقتاً ${Math.ceil(globalWait / 1000)}s دون تبديل الحساب`, {
                    operation: 'create_bot', stage: 'rate_limit', confirmed: false, global: true, retryAfterMs: globalWait,
                  });
                  // A global limit belongs to the current authentication scope;
                  // switching accounts is not a safe bypass. Stop cleanly so the
                  // user can resume after Discord's server-provided cooldown.
                  s.cancelRequested = true;
                  pushTsEvent('ts_progress');
                  continue;
                }
                const _isCf  = isCloudflareBlock(err);
                const _rlMs  = _isCf ? 0 : Math.max(retryAfterMs(err), 10_000);
                tsLog('warn', _isCf
                  ? `حظر Cloudflare على ${slot.name} [${currentEmail}] — تبديل فوري للحساب`
                  : `Rate limit (429) على ${slot.name} [${currentEmail}] — جاري البحث عن حساب بديل`);

                let _retryAllowed = true;
                if (!batchRateLimitHandled) {
                  batchRateLimitHandled = true;
                  setTsAccountCooldown(s, currentEmail, Date.now() + (_isCf ? 4 * 60 * 60 * 1000 : Math.max(_rlMs, 60_000)), _isCf ? 'cloudflare_block' : 'rate_limited', _isCf ? 'Cloudflare block' : 'Discord rate limit', { retryAfterMs: _isCf ? 4 * 60 * 60 * 1000 : Math.max(_rlMs, 60_000), global: false });
                  const switched = await switchToNextAccount();
                  if (switched) {
                    tsLog('info', `جاري الاستمرار من الحساب: ${currentEmail}`);
                  } else if (_isCf) {
                    tsLog('error', `حظر Cloudflare ولا يوجد حساب بديل — تخطّي ${slot.name}`);
                    _retryAllowed = false;
                  } else {
                    tsLog('warn', `لا يوجد حساب بديل — إيقاف الجلسة 60 ثانية ثم المحاولة…`);
                    s.state = 'waiting'; s.waitUntilTs = Date.now() + 60_000; s.waitTotalMs = 60_000;
                    pushTsEvent('ts_progress');
                    await tsSleep(60_000);
                    s.state = 'running'; s.waitUntilTs = 0; s.waitTotalMs = 0;
                    pushTsEvent('ts_progress');
                    try {
                      const _rh = await ts.accountHealthProbe({ token, netOpts });
                      if (!_rh.ready) throw new Error(_rh.message);
                      const _refreshed = await refreshDeveloperContext('انتهاء انتظار rate limit');
                      if (!_refreshed) {
                        _retryAllowed = false;
                        tsLog('error', 'لم تتم إعادة المحاولة بعد rate limit لأن جاهزية الحساب أو Portal لم تُؤكد', { operation: 'create_bot', stage: 'portal_refresh', confirmed: false });
                      }
                    } catch (_pe) {
                      _retryAllowed = false;
                      tsLog('error', 'تعذر فحص الحساب بعد الانتظار: ' + (_pe.message || _pe), { operation: 'create_bot', stage: 'account_health', confirmed: false });
                    }
                  }
                }
                if (_retryAllowed) {
                  // Fresh portal context before rate-limit retry (same logic as _switchAndRetry)
                  let _portalReadyForRetry = false;
                  try {
                    tsLog('info', `جلسة جديدة على ${currentEmail} (rate-limit) — تهيئة Developer Portal…`);
                    await ts.navigateTo({ client, page: 'https://discord.com/developers/applications' });
                    await ts.humanDelay(900, 1800, speedFactor);
                    await ts.listApplications({ token, netOpts });
                    await ts.humanDelay(700, 1400, speedFactor);
                    _portalReadyForRetry = true;
                    tsLog('info', `Developer Portal جاهز على ${currentEmail} — بدء إنشاء ${slot.name}`);
                  } catch (_fe) {
                    _retryAllowed = false;
                    tsLog('error', `تعذر تهيئة Portal (rate-limit): ` + (_fe.message || _fe), { operation: 'create_bot', stage: 'portal_refresh', confirmed: false });
                  }
                  if (_retryAllowed && _portalReadyForRetry) try {
                    const _retryStart = Date.now();
                    const { appPayload: rApp, botToken: rTok } = await _withBotTimeout(
                      createOneBotAsync(slot.botIndex, slot.num, slot.name, teamIdSnapshot),
                      slot.name
                    );
                    const rDurMs = Date.now() - _retryStart;
                    s.bots.push({ name: slot.name, appId: rApp.id, botUserId: rApp.bot?.id || null, token: rTok });
                    s.done += 1; s.failed -= 1; botsThisAccount += 1;
                    if (rules.linkBots && teamId) teamAppCounts[teamId] = (teamAppCounts[teamId] || 0) + 1;
                    tsLog('success', `تم (retry/${currentEmail}): ${slot.name}`, { durationMs: rDurMs, appId: rApp.id, botName: slot.name, operation: 'create_bot', confirmed: true, stage: 'complete' });
                    try {
                      const tkList = await readBotTokens();
                      const tkFiltered = tkList.filter(t => t.appId !== rApp.id);
                      tkFiltered.unshift({
                        appId: rApp.id, name: slot.name, icon: rApp.icon || null,
                        token: rTok, email: currentEmail || '',
                        resetAt: Date.now(), createdAt: Date.now(),
                      });
                      await writeBotTokens(tkFiltered);
                    } catch (_) {}
                    pushTsEvent('ts_bot_created', { bot: { name: slot.name, appId: rApp.id, hasToken: true, durationMs: rDurMs, isRetry: true } });
                  } catch (re) {
                    tsLog('error', `فشل retry ${slot.name} (حتى بعد التبديل): ` + (re?.message || re));
                  }
                }

              // ── 4) Any other unexpected error → try switching account once ───
              } else {
                tsLog('warn', `خطأ غير متوقع على ${slot.name} — محاولة التبديل للحساب البديل…`);
                await _switchAndRetry('generic-error');
              }

              pushTsEvent('ts_progress');
            }
          }

          // ── Session-budget: proactive account rotation ─────────────────────
          // If sessionBudget > 0 and current account has created ≥ N bots,
          // rotate NOW before Discord escalates security checks.
          if (sessionBudget > 0 && botsThisAccount >= sessionBudget && i < count && !s.cancelRequested) {
            tsLog('info', `حد الجلسة (${sessionBudget} بوت) اكتمل على ${currentEmail} تبديل استباقي للحساب…`);
            const budgetSwitched = await switchToNextAccount(); // resets botsThisAccount on success
            if (budgetSwitched) {
              tsLog('info', `تم تبديل الحساب استباقياً إلى ${currentEmail} — يبدأ العداد من صفر`, { operation: 'account_switch', confirmed: true });
            } else {
              tsLog('warn', `لا يوجد حساب بديل — مكمل على ${currentEmail} (budget ignored)`);
              botsThisAccount = 0; // reset anyway so we don't spam the log every bot
            }
          }

          writeData(d);
          pushTsEvent('ts_progress');

          if (batchDurationMs > LONG_CREATE_REFRESH_MS && !s.pendingCaptcha && !s.cancelRequested) {
            const refreshed = await refreshDeveloperContext(`دفعة الإنشاء أخذت ${Math.ceil(batchDurationMs / 1000)}s`);
            if (!refreshed && !s.cancelRequested) {
              s.state = 'error';
              s.lastError = 'تعذر تحديث Developer Portal بعد الدفعة؛ لم تستمر الجلسة دون تأكيد.';
              tsLog('error', s.lastError, { operation: 'portal_refresh', confirmed: false });
              pushTsEvent('ts_progress');
              break;
            }
          }
          i = batchEnd;

          // Inter-batch cooldown
          // Parallel mode: shorter (API pacing only, no human-mimicking needed)
          // Sequential mode: standard per-bot cooldown
          if (i < count && !s.cancelRequested) {
            const ms = useParallelMode
              ? Math.max(Math.round(1000 * speedFactor), waitMinutes * 60 * 1000)
              : Math.max(Math.round(2500 * speedFactor), waitMinutes * 60 * 1000);
            if (ms >= 60000) tsLog('info', 'انتظار ' + waitMinutes + ' دقيقة قبل الدُّفعة التالية…');
            else if (useParallelMode && ms > 300) tsLog('info', 'كولداون: ' + (ms / 1000).toFixed(1) + 's قبل الدُّفعة التالية…');
            await tsSleep(ms);
          }
        }
      }

      finalizeTs();
    } catch (e) {
      s.lastError = e.message || String(e);
      tsLog('error', 'خطأ في الجلسة: ' + s.lastError);
      finalizeTs(true);
    }
  }

  function finalizeTs(errored = false) {
    const s = tsSession();
    clearPendingTsCaptcha(errored ? 'Session ended after error' : 'Session finished');
    s.finishedAt = Date.now();
    s.current = '';
    s.waitUntilTs = 0;
    s.waitTotalMs = 0;
    if (s.cancelRequested) s.state = 'cancelled';
    else if (errored) s.state = 'error';
    else s.state = 'done';
    const d = ensureData();
    d.tsLastSession = { ...(d.tsLastSession || {}), state: s.state, done: s.done, failed: s.failed, finishedAt: s.finishedAt, updatedAt: Date.now() };
    writeData(d);
    tsLog('info', 'انتهت الجلسة — ' + s.done + ' نجاح · ' + s.failed + ' فشل');
    pushTsEvent('ts_done');
  }

  // Per-bot token export (download all bots from the most recent session)
  app.get('/api/ts/export', (req, res) => {
    const s = tsSession();
    const list = (s.bots || []).slice();
    const fmt = String(req.query.format || 'text').toLowerCase();
    if (fmt === 'json') {
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="true_studio_report.json"');
      return res.send(JSON.stringify({ exportedAt: new Date().toISOString(), summary: { state: s.state, total: s.total, done: s.done, failed: s.failed }, config: { account: s.account, rules: s.rules, teamId: s.teamId, teamName: s.teamName }, bots: list }, null, 2));
    }
    const csvCell = (value) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    if (fmt === 'csv') {
      const rows = list.map((b, i) => [i + 1, b.name, b.appId, b.botUserId, b.token || '', s.account || ''].map(csvCell).join(','));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="true_studio_bots.csv"');
      return res.send('\ufeffnumber,name,app_id,bot_user_id,token,account\n' + rows.join('\n') + '\n');
    }
    const lines = list.map((b, i) => String(i + 1).padStart(3, '0') + '\t' + b.name + '\t' + (b.token || ''));
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="true_studio_tokens.txt"');
    res.send('# number\tname\ttoken\n' + lines.join('\n') + '\n');
  });
  
const SSE_FEATURES_MAX = 200;
app.get('/api/features/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(`: connected\n\n`);
  const types = (req.query.types || '').split(',').filter(Boolean);
  const sc = { res, types: types.length ? types : null, uid: currentUserId() };

  if (featureSSE.size >= SSE_FEATURES_MAX) {
    const oldest = featureSSE.values().next().value;
    if (oldest) {
      try { oldest.res.end(); } catch {}
      featureSSE.delete(oldest);
    }
  }
  featureSSE.add(sc);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    featureSSE.delete(sc);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot-Studio running on http://localhost:${PORT}`);
  const isReplit = !!(process.env.REPL_ID || process.env.REPLIT_DEV_DOMAIN || process.env.REPL_SLUG);
  if (!isReplit && !process.env.NO_OPEN) {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
