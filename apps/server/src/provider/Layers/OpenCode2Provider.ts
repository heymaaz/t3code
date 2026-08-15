import {
  type OpenCode2Settings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { collectSessionConfigOptionValues } from "../acp/AcpRuntimeModel.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  makeOpenCode2AcpRuntime,
  resolveOpenCode2AcpBaseModelId,
} from "../acp/OpenCode2AcpSupport.ts";

const OpenCODE2_PRESENTATION = {
  displayName: "OpenCode 2",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const OpenCODE2_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const OpenCODE2_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [];

export function buildInitialOpenCode2ProviderSnapshot(
  opencode2Settings: OpenCode2Settings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = opencode2ModelsFromSettings(opencode2Settings.customModels);

    if (!opencode2Settings.enabled) {
      return buildServerProvider({
        presentation: OpenCODE2_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenCode2 is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OpenCODE2_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking OpenCode2 CLI availability...",
      },
    });
  });
}

function opencode2ModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = OpenCODE2_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildOpenCode2DiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions?.find((option) => option.category === "model");
  if (!modelOption) {
    return [];
  }
  const seen = new Set<string>();
  return collectSessionConfigOptionValues(modelOption)
    .map((modelId): ServerProviderModel | undefined => {
      const slug = resolveOpenCode2AcpBaseModelId(modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const discoverOpenCode2ModelsViaAcp = (
  opencode2Settings: OpenCode2Settings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeOpenCode2AcpRuntime({
      opencode2Settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return {
      models: buildOpenCode2DiscoveredModelsFromConfigOptions(
        started.sessionSetupResult.configOptions ?? undefined,
      ),
      version: started.initializeResult.agentInfo?.version ?? null,
    };
  }).pipe(Effect.scoped);

const runOpenCode2VersionCommand = (
  opencode2Settings: OpenCode2Settings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = opencode2Settings.binaryPath || "opencode2";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkOpenCode2ProviderStatus = Effect.fn("checkOpenCode2ProviderStatus")(function* (
  opencode2Settings: OpenCode2Settings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = opencode2ModelsFromSettings(opencode2Settings.customModels);

  if (!opencode2Settings.enabled) {
    return buildServerProvider({
      presentation: OpenCODE2_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode2 is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOpenCode2VersionCommand(opencode2Settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("OpenCode2 CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OpenCODE2_PRESENTATION,
      enabled: opencode2Settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "OpenCode2 CLI (`opencode2`) is not installed or not on PATH."
          : "Failed to execute OpenCode2 CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OpenCODE2_PRESENTATION,
      enabled: opencode2Settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenCode2 CLI is installed but timed out while running `opencode2 --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("OpenCode2 CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OpenCODE2_PRESENTATION,
      enabled: opencode2Settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenCode2 CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverOpenCode2ModelsViaAcp(opencode2Settings, environment).pipe(
    Effect.timeoutOption(OpenCODE2_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("OpenCode2 ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: OpenCODE2_PRESENTATION,
      enabled: opencode2Settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "OpenCode2 CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `OpenCode2 ACP model discovery timed out after ${OpenCODE2_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: OpenCODE2_PRESENTATION,
      enabled: opencode2Settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `OpenCode2 CLI is installed but ACP startup timed out after ${OpenCODE2_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovered = discoveryExit.value.value;
  const discoveredModels = discovered.models;
  const discoveredVersion = discovered.version ?? version;
  const models =
    discoveredModels.length > 0
      ? opencode2ModelsFromSettings(opencode2Settings.customModels, discoveredModels)
      : fallbackModels;

  if (models.length === 0) {
    return buildServerProvider({
      presentation: OpenCODE2_PRESENTATION,
      enabled: opencode2Settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: discoveredVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenCode 2 ACP is running but no models are configured.",
      },
    });
  }

  return buildServerProvider({
    presentation: OpenCODE2_PRESENTATION,
    enabled: opencode2Settings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: discoveredVersion,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichOpenCode2Snapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("OpenCode2 version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
