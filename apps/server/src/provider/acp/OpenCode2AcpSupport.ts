import { type OpenCode2Settings, type ProviderOptionSelection } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type OpenCode2AcpRuntimeInput = Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> & {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly opencode2Settings: Pick<OpenCode2Settings, "binaryPath"> | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
};

export function buildOpenCode2AcpSpawnInput(
  settings: Pick<OpenCode2Settings, "binaryPath"> | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "opencode2",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOpenCode2AcpRuntime = (
  input: OpenCode2AcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOpenCode2AcpSpawnInput(input.opencode2Settings, input.cwd, input.environment),
        authMethodId: "opencode-login",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveOpenCode2AcpBaseModelId(model: string | null | undefined): string {
  return model?.trim() || "openai/gpt-5";
}

export function currentOpenCode2ModelIdFromSessionSetup(
  response:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const option = response.configOptions?.find((entry) => entry.category === "model");
  if (!option || option.type !== "select") return undefined;
  return option.currentValue?.trim() || undefined;
}

interface ModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: AcpSessionRuntime.AcpSessionRuntime["Service"]["setConfigOption"];
}

function modeOption(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return options.find((option) => option.id === "mode" || option.category === "mode");
}

function modeValue(
  option: EffectAcpSchema.SessionConfigOption,
  mode: "plan" | "default",
): string | undefined {
  if (option.type !== "select") return undefined;
  const values = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  const match = values.find((entry) => {
    const value = `${entry.value} ${entry.name}`.toLowerCase();
    return mode === "plan" ? value.includes("plan") : value.includes("build");
  });
  return match?.value;
}

export function applyOpenCode2AcpModelSelection<E>(input: {
  readonly runtime: ModelSelectionRuntime;
  readonly model: string | undefined;
  readonly interactionMode?: "plan" | "default" | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const options = yield* input.runtime.getConfigOptions;
    const modelOption = options.find((entry) => entry.category === "model");
    const requestedModel = input.model ? resolveOpenCode2AcpBaseModelId(input.model) : undefined;
    const currentModel = modelOption?.type === "select" ? modelOption.currentValue : undefined;
    if (modelOption && requestedModel && requestedModel !== currentModel) {
      yield* input.runtime
        .setConfigOption(modelOption.id, requestedModel)
        .pipe(Effect.mapError(input.mapError));
    }

    const refreshedOptions =
      input.model && requestedModel !== currentModel
        ? yield* input.runtime.getConfigOptions
        : options;
    const requestedMode = input.interactionMode;
    const selectedModeOption = modeOption(refreshedOptions);
    const selectedModeValue =
      requestedMode && selectedModeOption
        ? modeValue(selectedModeOption, requestedMode)
        : undefined;
    if (selectedModeOption && selectedModeValue) {
      yield* input.runtime
        .setConfigOption(selectedModeOption.id, selectedModeValue)
        .pipe(Effect.mapError(input.mapError));
    }

    for (const selection of input.selections ?? []) {
      const option = refreshedOptions.find((entry) => entry.id === selection.id);
      if (selection.id === "mode" || option === selectedModeOption) {
        continue;
      }
      if (option) {
        yield* input.runtime
          .setConfigOption(option.id, selection.value)
          .pipe(Effect.mapError(input.mapError));
      }
    }
    return (requestedModel ?? currentModel?.trim()) || undefined;
  });
}
