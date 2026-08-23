import { defineRailway, github, project, service } from "railway/iac";

export default defineRailway(() => {
  const web = service("botv3", {
    source: github("atoxic374-alt/Botv3", {
      branch: "main",
    }),
    build: "pnpm install --frozen-lockfile --prefer-offline",
    start: "pnpm start",
    healthcheck: "/api/healthz",
    healthcheckTimeout: 120,
  });

  return project("botv3", {
    resources: [web],
  });
});
