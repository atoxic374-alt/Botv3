(function watchBuildStamp() {
  const boot = window.__BUILD_STAMP__ || null;
  if (!boot) return;
  let banner = null;

  function showBanner() {
    if (banner) return;
    banner = document.createElement('button');
    banner.type = 'button';
    banner.className = 'reload-banner';
    banner.textContent = 'تم تحديث Bot-Studio - اضغط لإعادة التحميل';
    banner.addEventListener('click', () => window.location.reload());
    document.body.appendChild(banner);
  }

  async function check() {
    try {
      const r = await fetch('/api/build-stamp', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j?.stamp && String(j.stamp) !== String(boot)) showBanner();
    } catch (_) {}
  }

  setTimeout(check, 4000);
  setInterval(check, 30000);
})();

async function apiCall(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    return { success: false, error: 'Network error: ' + (e?.message || 'fetch failed') };
  }

  const ctype = (res.headers?.get?.('content-type') || '').toLowerCase();
  const text = await res.text();
  if (ctype.includes('application/json') || /^[\s\uFEFF]*[{[]/.test(text)) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
    if (data) {
      // The API uses a JSON success flag even for validation and business
      // errors. Treat those responses as rejected promises so every button
      // follows the same failure path instead of showing false success.
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || `Server returned ${res.status}`);
      }
      return data;
    }
  }

  const snippet = (text || '').replace(/\s+/g, ' ').slice(0, 140).trim();
  return {
    success: false,
    error: `Server returned ${res.status} ${res.statusText || ''}`.trim() + (snippet ? ` - ${snippet}` : ''),
    httpStatus: res.status,
  };
}

window.electronAPI = {
  openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),

  tsAccounts: () => apiCall('GET', '/api/ts/accounts'),
  tsSaveAccount: (payload) => apiCall('POST', '/api/ts/accounts', payload),
  tsSaveBulkTokens: (tokens) => apiCall('POST', '/api/ts/accounts/bulk-tokens', { tokens }),
  tsDeleteBulkTokens: () => apiCall('DELETE', '/api/ts/accounts/bulk-tokens'),
  tsDeleteAccount: (email) => apiCall('DELETE', `/api/ts/accounts/${encodeURIComponent(email)}`),
  tsState: () => apiCall('GET', '/api/ts/state'),
  tsStart: (cfg) => apiCall('POST', '/api/ts/start', cfg),
  tsPause: () => apiCall('POST', '/api/ts/pause'),
  tsResumeInfo: () => apiCall('GET', '/api/ts/resume'),
  tsDryRun: (cfg) => apiCall('POST', '/api/ts/dry-run', cfg),
  tsProfiles: () => apiCall('GET', '/api/ts/profiles'),
  tsSaveProfile: (name, config, id) => apiCall('POST', '/api/ts/profiles', { name, config, id }),
  tsDeleteProfile: (id) => apiCall('DELETE', `/api/ts/profiles/${encodeURIComponent(id)}`),
  tsStop: () => apiCall('POST', '/api/ts/stop'),
  tsClearLog: () => apiCall('POST', '/api/ts/clear-log'),
  tsTestAccount: (email) => apiCall('POST', '/api/ts/test-account', { email }),
  tsJoinServer: (email, inviteUrl) => apiCall('POST', '/api/ts/join-server', { email, inviteUrl }),
  tsNitroStatus: (email) => apiCall('GET', `/api/ts/nitro/status?email=${encodeURIComponent(email)}`),
  tsNitroPost: (email, guildId, inviteUrl, count) => apiCall('POST', '/api/ts/nitro/post', { email, guildId, inviteUrl, count }),
  tsLibrary: (email) => apiCall('GET', `/api/ts/library?email=${encodeURIComponent(email)}`),
  tsResetBot: (appId, email, name, icon) =>
    apiCall('POST', `/api/ts/applications/${encodeURIComponent(appId)}/reset-bot-token`, {
      email,
      name: name || appId,
      icon: icon || null,
    }),
  tsGetIntents: (appId, email) =>
    apiCall('GET', `/api/ts/applications/${encodeURIComponent(appId)}/intents?email=${encodeURIComponent(email)}`),
  tsSetIntents: (appId, email, enabled) =>
    apiCall('POST', `/api/ts/applications/${encodeURIComponent(appId)}/intents`, { email, enabled }),
  tsApplyIntentsAll: (email, enabled = true, appIds = []) =>
    apiCall('POST', '/api/ts/intents/apply-all', { email, enabled, appIds }),
  tsGetPfp: () => apiCall('GET', '/api/ts/pfp'),
  tsSavePfp: (payload) => apiCall('POST', '/api/ts/pfp', payload),
  tsApplyPfpAll: (email, appIds = []) => apiCall('POST', '/api/ts/pfp/apply-all', { email: email || '', appIds }),
  tsGetAutoIntents: () => apiCall('GET', '/api/ts/auto-intents'),
  tsSetAutoIntents: (enabled) => apiCall('POST', '/api/ts/auto-intents', { enabled }),
  tsExportUrl: (format = 'text') => `/api/ts/export?format=${encodeURIComponent(format)}`,
  tsBrightDataSettings: () => apiCall('GET', '/api/ts/brightdata-settings'),
  tsSaveBrightDataSettings: (payload) => apiCall('POST', '/api/ts/brightdata-settings', payload),
  tsCaptchaSettings: () => apiCall('GET', '/api/ts/captcha-settings'),
  tsSaveCaptchaSettings: (payload) => apiCall('POST', '/api/ts/captcha-settings', payload),
  tsCaptchaVerify: () => apiCall('GET', '/api/ts/captcha-verify'),
  tsResolveCaptcha: (id, token) =>
    apiCall('POST', `/api/ts/captcha-resolve/${encodeURIComponent(id)}`, { token }),
  tsCancelCaptcha: (id) => apiCall('POST', `/api/ts/captcha-cancel/${encodeURIComponent(id)}`),
  tsBotTokens: () => apiCall('GET', '/api/ts/bot-tokens'),
  tsSaveBotToken: (data) => apiCall('POST', '/api/ts/bot-tokens', data),
  tsDeleteBotToken: (appId) => apiCall('DELETE', `/api/ts/bot-tokens/${encodeURIComponent(appId)}`),
  tsVerifyProxy: (payload) => apiCall('POST', '/api/ts/proxy-verify',
    typeof payload === 'string' ? { proxyUrl: payload } : (payload || {})),
  tsProxyPreflight: (payload) => apiCall('POST', '/api/ts/proxy-preflight', payload || {}),
  tsListTeams: (email) => apiCall('GET', `/api/ts/teams?email=${encodeURIComponent(email)}`),
  tsCreateTeam: (email, name, count = 1) => apiCall('POST', '/api/ts/teams/create', { email, name, count }),
  tsAddAppToTeam: (email, appId, teamId) =>
    apiCall('POST', `/api/ts/teams/${encodeURIComponent(teamId)}/add-app`, { email, appId }),
  tsResetAllStart: (email, bots, selectionActive = false) =>
    apiCall('POST', '/api/ts/reset-all/start', { email, bots, selectionActive }),
  tsResetAllState: () => apiCall('GET', '/api/ts/reset-all/state'),
  tsResetAllStop: () => apiCall('POST', '/api/ts/reset-all/stop'),
  tsBotInviteGuilds: (email) => apiCall('GET', `/api/ts/bot-invite-guilds?email=${encodeURIComponent(email)}`),
};
