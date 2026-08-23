# Railway deployment

The repository includes optional Railway deployment configuration. `railway.json` supports legacy service deployments, while `.railway/railway.ts` is the current Infrastructure as Code entry point for the Railway CLI. Neither file participates in local Node.js, Freeway, or Replit runs; those environments continue to use their own commands.

Use one Railway configuration mode for a given service. Existing services that already use `railway.json` should remain on that file until migrated with Railway's migration workflow. New Railway projects should use `.railway/railway.ts` through `railway config plan` and `railway config apply`.

## Recommended Railway service

Deploy the repository root as one service. Use `/` as the service root directory and keep the service connected to the repository root. Railway's automatic JavaScript monorepo importer may detect the packages under `artifacts/*`, `lib/*`, and `scripts`; those packages are workspace libraries and are not Botv3 services. Do not deploy them as separate runtime services.

The root configuration selects Railpack, installs with the locked pnpm graph, starts `pnpm start`, and checks `/api/healthz`. The application listens on Railway's injected `PORT` value and binds to `0.0.0.0`. The IaC file points to `atoxic374-alt/Botv3` on `main` and declares one service named `botv3`; it does not declare databases, volumes, domains, or secrets.

If Railway created multiple services during import, keep one service for the repository root and remove or ignore the staged workspace-library services. The IaC file is intentionally not applied automatically by a normal Git push; review it with `railway config plan` first. Railway configuration files control deployment settings for the service that uses them; they do not change the project dashboard or force other platforms to use Railway.

## Required runtime settings

| Setting | Value |
|---|---|
| Service root | `/` |
| Build command | `pnpm install --frozen-lockfile --prefer-offline` |
| Start command | `pnpm start` |
| Health check | `/api/healthz` |
| Port | Railway-provided `PORT` |

Do not put Discord tokens, passwords, TOTP secrets, CAPTCHA keys, or proxy credentials in this file. Add secrets through Railway variables or the application's protected storage flow.
