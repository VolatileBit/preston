import { describe, it } from "vitest";
import { type Provider, usableProviders } from "./providers.js";
import { scenarioResult } from "./world.js";

/**
 * Declares one smoke scenario, run once per provider in `providers` that this machine can use
 * (installed, signed in, offering the cheap model, and listed in SMOKE_PROVIDERS). A provider
 * that cannot be used is skipped with the reason; the result and cost go to the run summary.
 */
export function smokeScenario(
  name: string,
  providers: Provider[],
  body: (ctx: { provider: Provider; startedAt: number }) => Promise<void>,
  options: { timeoutMs?: number } = {},
): void {
  describe(name, () => {
    for (const provider of providers) {
      it(
        `${provider}`,
        async (ctx) => {
          const status = (await usableProviders()).find((p) => p.provider === provider);
          if (!status?.usable) {
            scenarioResult(name, provider, Date.now(), "skipped", status?.reason);
            ctx.skip(status?.reason ?? "provider not usable");
            return;
          }
          const startedAt = Date.now();
          try {
            await body({ provider, startedAt });
            scenarioResult(name, provider, startedAt, "pass");
          } catch (err) {
            scenarioResult(name, provider, startedAt, "fail", String(err).slice(0, 160));
            throw err;
          }
        },
        options.timeoutMs ?? 10 * 60_000,
      );
    }
  });
}
