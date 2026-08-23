# Botv3

Botv3 is a standalone Express and vanilla JavaScript web application for managing Discord bot workflows, account sessions, library operations, rate-limit handling, and live progress logs. The application entrypoint is the root `server.js`; the root `index.html` is the user interface.

## Run and operate

Run the application with `node server.js` or `npm start`. The server listens on `process.env.PORT` and defaults to port `5000`, which is the port configured for Replit Webview and deployment. Do not start the nested `artifacts/api-server` or `mockup-sandbox` packages for the production Botv3 interface; those directories are unrelated workspace artifacts.

The main local checks are `npm run test:operations` for rate-limit logic and `npm run test:smoke` for safe HTTP contracts. Syntax checks can be run with `node --check server.js`, `node --check lib/trueStudio.js`, and `node --check src/components/TrueStudioManager.js`.

## Stack and structure

| Area | Source of truth |
|---|---|
| HTTP server and static hosting | `server.js` |
| Discord transport and operation contracts | `lib/trueStudio.js` |
| Frontend bootstrap | `index.html`, `src/main.js` |
| Main workspace UI | `src/components/TrueStudioManager.js` |
| Frontend API bridge | `src/api.js` |
| Styles and responsive themes | `src/styles/*.css` |
| Scoped local persistence | `lib/userScope.js`, `lib/jsonStore.js`, `data/` |
| Local operation tests | `scripts/operations-logic-test.cjs`, `scripts/smoke-test.cjs` |

The application is intentionally not a React, Vite, tRPC, or PostgreSQL workspace. The `artifacts/` and `lib/*/package.json` files are supporting workspace artifacts and must not replace the root server when configuring Replit.

## Replit deployment

The root `.replit` file runs `node server.js`, waits on local port `5000`, maps that port to the Webview, and uses the same command for VM deployment. Replit must expose the application root rather than a nested workspace preview. A request to `/` or `/index.html` should return the Botv3 interface, while `/api/healthz` provides the server health endpoint.

The server binds to `0.0.0.0` and uses the platform-provided `PORT` value. Do not hard-code a public port in application code or add another competing web server. Keep local test data, tokens, backups, `.env` files, and encryption keys out of Git.

## Product behavior

Botv3 supports account setup, direct-token warmup, optional email and password access, profiles, dry-run validation, session start/pause/stop, account health checks, rate-limit-aware switching, Discord application library management, team operations, bot invites, intents, identity settings, token reset, Reset All, exports, and a concise Live Log. Destructive or bulk library operations require a complete verified library and must not report success without confirmation.

When changing frontend operations, preserve the existing API bridge and terminal SSE handling. Every operation needs a loading state, a concise success or failure result, and a truthful partial or unconfirmed state when Discord does not verify the side effect.

## Gotchas

The server stores scoped local data under `data/`; never commit runtime changes from tests. Discord rate limits must use server-provided `Retry-After` and bucket or global metadata rather than hard-coded limits. A global rate limit must not be bypassed by switching accounts. Live Discord, MFA, and CAPTCHA actions require explicitly authorized credentials and are not part of local smoke tests.
