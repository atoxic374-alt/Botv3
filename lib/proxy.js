// lib/proxy.js
// ───────────────────────────────────────────────────────────────────
// Build the agent object that discord.js-selfbot-v13 expects for a
// given proxy URL. Supports http://, https://, socks://, socks4://,
// socks5:// (with optional user:pass@host:port).
//
// discord.js-selfbot-v13 expects the SAME agent object for both:
//   REST  : client.options.http.agent → agent instance
//   WS    : client.options.ws.agent   → agent instance (NOT {httpAgent, httpsAgent})
//
// Returns { agent } where agent is an HttpsProxyAgent or SocksProxyAgent.
// Call buildProxyAgents() once per Client — never share agent instances between clients.
// Throws Error('Unsupported proxy scheme: …') for invalid input.
// ───────────────────────────────────────────────────────────────────

const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

function normalize(url) {
  if (!url || typeof url !== 'string') return null;
  const v = url.trim();
  if (!v) return null;
  // Be forgiving: bare "host:port" → assume http
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return 'http://' + v;
  return v;
}

/**
 * Build a proxy agent suitable for both REST and WebSocket in discord.js-selfbot-v13.
 * Returns { agent } or null if no proxy URL is provided.
 * Always creates a NEW agent instance — never share between clients.
 */
function buildProxyAgents(rawUrl, opts = {}) {
  const url = normalize(rawUrl);
  if (!url) return null;

  let parsed;
  try { parsed = new URL(url); } catch (e) {
    throw new Error('Invalid proxy URL: ' + e.message);
  }

  const scheme = parsed.protocol.toLowerCase().replace(':', '');

  if (scheme === 'socks' || scheme === 'socks4' || scheme === 'socks5' || scheme === 'socks5h') {
    const agent = new SocksProxyAgent(url, opts);
    return { agent, httpAgent: agent, httpsAgent: agent };
  }

  if (scheme === 'http' || scheme === 'https') {
    const httpsAgent = new HttpsProxyAgent(url, opts);
    const httpAgent = scheme === 'http' ? new HttpProxyAgent(url, opts) : httpsAgent;
    return { agent: httpsAgent, httpAgent, httpsAgent };
  }

  throw new Error('Unsupported proxy scheme: ' + scheme);
}

function isBrightDataUrl(rawUrl) {
  const url = normalize(rawUrl);
  if (!url) return false;
  try {
    const u = new URL(url);
    return /(^|\.)brd\.superproxy\.io$/i.test(u.hostname) || /^brd-customer-/i.test(decodeURIComponent(u.username || ''));
  } catch (_) {
    return /brd\.superproxy\.io|brd-customer-/i.test(String(rawUrl || ''));
  }
}

function proxyErrorMessage(err) {
  const msg = String(err?.message || err || '');
  if (/client_10030|ip_forbidden|not whitelisted|Allowed IPs/i.test(msg)) {
    const ip = msg.match(/request:\s*([0-9.]+)/i)?.[1] || msg.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0] || '';
    return `Bright Data IP allowlist blocked${ip ? ` — أضف ${ip} إلى Allowed IPs في إعدادات الـ zone` : ' — أضف IP الخادم إلى Allowed IPs في إعدادات الـ zone'}`;
  }
  if (/client_10002|zone not found/i.test(msg)) return 'Bright Data zone غير موجود أو معطل — تحقق من Zone Name وحالة Active';
  if (/client_10020|Account is suspended/i.test(msg)) return 'Bright Data account suspended — فعّل الحساب أو راجع billing';
  if (/client_10040|KYC Required/i.test(msg)) return 'Bright Data KYC required — أكمل التحقق في الحساب';
  if (/policy_20140|bad_endpoint|immediate residential|no KYC|robots\.txt|Requested site is not available/i.test(msg)) {
    return 'BrightData "Limited Access" يحجب هذا الدومين (policy_20140) — اذهب: Zone → Configuration → Target Whitelist → احذف القائمة كلياً (اتركها فارغة) أو أضف discord.com و2captcha.com';
  }
  if (/client_10250|not an allowed target|target .* whitelist|got blocked since this host/i.test(msg)) {
    const host = msg.match(/target\s+([a-z0-9.-]+)\s+but got blocked/i)?.[1]
      || msg.match(/\bbrdtest\.com\b/i)?.[0]
      || 'brdtest.com';
    return `Bright Data target whitelist blocked — أضف ${host} إلى Target whitelist في الـ zone أو احذف whitelist للسماح بالفحص والتشغيل`;
  }
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) return 'Proxy timeout — تحقق من host/port أو حالة الـ zone';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'Proxy host غير معروف — تحقق من host';
  if (/ECONNREFUSED/i.test(msg)) return 'Proxy refused connection — تحقق من port والبروتوكول';
  if (/407|authentication/i.test(msg)) return 'Proxy authentication failed (407) — انسخ Username وPassword من Bright Data Access details كما هما';
  if (/self[- ]signed|certificate|SSL/i.test(msg)) return 'SSL certificate error — جرّب HTTP 33335 أو فعّل شهادة Bright Data';
  return msg || 'Proxy test failed';
}

function brightDataHeaderDetail(headers = {}) {
  const brdCode = headers['x-brd-err-code'] || '';
  const brdError = headers['x-brd-error'] || '';
  const brdMsg = headers['x-brd-err-msg'] || '';
  const proxyStatus = String(headers['proxy-status'] || '');
  const proxyStatusLooksBad = /(?:error|client_|forbidden|blocked|denied|received-status=(?:4|5)\d\d)/i.test(proxyStatus);
  return [brdCode, brdError, brdMsg, proxyStatusLooksBad ? proxyStatus : ''].filter(Boolean).join(' — ');
}

let insecureTlsDepth = 0;
let insecureTlsPrevious;
function enterInsecureTlsForProxyTest() {
  if (insecureTlsDepth === 0) {
    insecureTlsPrevious = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  insecureTlsDepth += 1;
  return () => {
    insecureTlsDepth = Math.max(0, insecureTlsDepth - 1);
    if (insecureTlsDepth === 0) {
      if (insecureTlsPrevious === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = insecureTlsPrevious;
      insecureTlsPrevious = undefined;
    }
  };
}

// Quick reachability test. Hits a small endpoint THROUGH the proxy and
// returns the egress IP so the user gets immediate confirmation.
async function testProxy(rawUrl, opts = {}) {
  const agentOpts = opts.insecureSkipTlsVerify ? { rejectUnauthorized: false } : {};
  const agents = buildProxyAgents(rawUrl, agentOpts);
  if (!agents) throw new Error('Empty proxy URL');
  const targetUrl = opts.targetUrl || (isBrightDataUrl(rawUrl)
    ? (String(normalize(rawUrl) || '').startsWith('socks') ? 'https://brdtest.com/myip.json' : 'http://brdtest.com/myip.json')
    : 'https://api.ipify.org?format=json');
  const timeout = Math.max(3000, Math.min(30000, Number(opts.timeoutMs || 12000)));
  const acceptStatus = typeof opts.acceptStatus === 'function'
    ? opts.acceptStatus
    : (status) => status >= 200 && status < 300;
  const restoreTls = opts.insecureSkipTlsVerify ? enterInsecureTlsForProxyTest() : null;
  try {
    const res = await axios.get(targetUrl, {
      httpAgent: agents.httpAgent || agents.agent,
      httpsAgent: agents.httpsAgent || agents.agent,
      ...(opts.insecureSkipTlsVerify ? { rejectUnauthorized: false } : {}),
      proxy: false,
      timeout,
      validateStatus: () => true,
      responseType: 'json',
      transitional: { forcedJSONParsing: false },
    });
    const brdDetail = brightDataHeaderDetail(res.headers || {});
    if (brdDetail) {
      throw new Error(`Proxy target returned HTTP ${res.status} — ${brdDetail}`);
    }
    if (!acceptStatus(res.status)) {
      const body = typeof res.data === 'string'
        ? res.data.replace(/\s+/g, ' ').slice(0, 180)
        : JSON.stringify(res.data || {}).slice(0, 180);
      throw new Error(`Proxy target returned HTTP ${res.status}${body ? ' — ' + body : ''}`);
    }
    let data = {};
    if (typeof res.data === 'string') {
      try { data = JSON.parse(res.data); } catch (_) { data = {}; }
    } else {
      data = res.data || {};
    }
    return {
      ok: true,
      ip: data.ip || data.query || data.origin || res.headers?.['x-brd-ip'] || res.headers?.['x-luminati-ip'] || null,
      targetUrl,
      country: data.country || data.country_code || null,
      status: res.status,
    };
  } catch (e) {
    throw new Error(proxyErrorMessage(e));
  } finally {
    if (restoreTls) restoreTls();
  }
}

// Mask credentials for safe display in the UI / logs.
function maskProxy(rawUrl) {
  const url = normalize(rawUrl);
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    return u.toString().replace(/\/$/, '');
  } catch (e) { return '***'; }
}

module.exports = { buildProxyAgents, testProxy, maskProxy, normalize, isBrightDataUrl };
