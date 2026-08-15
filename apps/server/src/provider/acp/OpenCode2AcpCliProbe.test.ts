/** Optional live check. Enable with T3_OPENCODE2_ACP_PROBE=1. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const live = describe.runIf(process.env.T3_OPENCODE2_ACP_PROBE === "1");

function provideRuntime(resumeSessionId?: string) {
  return AcpSessionRuntime.layer({
    spawn: { command: "opencode2", args: ["acp"], cwd: process.cwd() },
    cwd: process.cwd(),
    clientInfo: { name: "t3-opencode2-probe", version: "0.0.0" },
    authMethodId: "opencode-login",
    ...(resumeSessionId ? { resumeSessionId } : {}),
  }).pipe(Layer.provideMerge(NodeServices.layer));
}

live("OpenCode 2 ACP CLI probe", () => {
  it.effect("initializes, authenticates, discovers configuration, and resumes", () =>
    Effect.gen(function* () {
      const runSession = (resumeSessionId?: string) =>
        Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          const started = yield* runtime.start();
          expect(started.initializeResult.protocolVersion).toBe(1);
          expect(typeof started.initializeResult.agentInfo?.version).toBe("string");
          const options = started.sessionSetupResult.configOptions ?? [];
          expect(options.some((option) => option.category === "model")).toBe(true);
          expect(options.some((option) => option.id === "effort")).toBe(true);
          const model = options.find((option) => option.category === "model");
          if (model?.type === "select") {
            yield* runtime.setConfigOption(model.id, model.currentValue);
          }
          const mode = options.find((option) => option.id === "mode");
          expect(mode).toBeDefined();
          if (mode?.type === "select") {
            const values = mode.options.flatMap((entry) =>
              "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
            );
            expect(values).toEqual(expect.arrayContaining(["build", "plan"]));
          }
          return { runtime, started };
        }).pipe(Effect.provide(provideRuntime(resumeSessionId)), Effect.scoped);

      const first = yield* runSession();
      const resumed = yield* runSession(first.started.sessionId);
      expect(resumed.started.sessionId).toBe(first.started.sessionId);
    }).pipe(Effect.scoped),
  );
});
