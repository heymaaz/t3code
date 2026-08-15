import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyOpenCode2AcpModelSelection,
  buildOpenCode2AcpSpawnInput,
  resolveOpenCode2AcpBaseModelId,
} from "./OpenCode2AcpSupport.ts";

describe("OpenCode2AcpSupport", () => {
  it("spawns the V2 ACP command and preserves the environment", () => {
    expect(
      buildOpenCode2AcpSpawnInput({ binaryPath: "/usr/local/bin/opencode2" }, "/tmp/project", {
        HOME: "/tmp/home",
      }),
    ).toEqual({
      command: "/usr/local/bin/opencode2",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HOME: "/tmp/home" },
    });
  });

  it("preserves provider/model identifiers", () => {
    expect(resolveOpenCode2AcpBaseModelId("  anthropic/claude-sonnet  ")).toBe(
      "anthropic/claude-sonnet",
    );
    expect(resolveOpenCode2AcpBaseModelId(undefined)).toBe("openai/gpt-5");
  });

  it.effect("selects model and negotiated options through ACP config", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      const runtime = {
        getConfigOptions: Effect.succeed([
          {
            id: "model",
            category: "model" as const,
            type: "select" as const,
            name: "Model",
            currentValue: "openai/gpt-5",
            options: [{ value: "openai/gpt-5", name: "GPT-5" }],
          },
          {
            id: "effort",
            category: "effort" as const,
            type: "select" as const,
            name: "Effort",
            currentValue: "low",
            options: [{ value: "low", name: "Low" }],
          },
        ]),
        setConfigOption: (id: string, value: string | boolean) => {
          calls.push([id, value]);
          return Effect.succeed(undefined as never);
        },
        setMode: (mode: string) => {
          calls.push(["mode", mode]);
          return Effect.succeed(undefined as never);
        },
      };

      const model = yield* applyOpenCode2AcpModelSelection({
        runtime,
        model: "anthropic/claude-sonnet",
        selections: [{ id: "effort", value: "high" }],
        mapError: (cause) => String(cause),
      });

      expect(model).toBe("anthropic/claude-sonnet");
      expect(calls).toEqual([
        ["model", "anthropic/claude-sonnet"],
        ["effort", "high"],
      ]);
    }),
  );

  it.effect("keeps plan interaction mode authoritative over a build selection", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      const runtime = {
        getConfigOptions: Effect.succeed([
          {
            id: "mode",
            category: "mode" as const,
            type: "select" as const,
            name: "Mode",
            currentValue: "build",
            options: [
              { value: "plan", name: "Plan" },
              { value: "build", name: "Build" },
            ],
          },
        ]),
        setConfigOption: (id: string, value: string | boolean) => {
          calls.push([id, value]);
          return Effect.succeed(undefined as never);
        },
      };

      yield* applyOpenCode2AcpModelSelection({
        runtime,
        model: undefined,
        interactionMode: "plan",
        selections: [{ id: "mode", value: "build" }],
        mapError: (cause) => String(cause),
      });

      expect(calls).toEqual([["mode", "plan"]]);
    }),
  );
});
