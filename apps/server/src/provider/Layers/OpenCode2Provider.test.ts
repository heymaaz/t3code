// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OpenCode2Settings } from "@t3tools/contracts";
import {
  buildInitialOpenCode2ProviderSnapshot,
  checkOpenCode2ProviderStatus,
} from "./OpenCode2Provider.ts";

const decodeSettings = Schema.decodeSync(OpenCode2Settings);
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

async function makeMockBinary(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode2-provider-"));
  const binary = NodePath.join(directory, "opencode2");
  await NodeFSP.writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.0.0-test"; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(binary, 0o755);
  return binary;
}

describe("OpenCode2Provider", () => {
  it.effect("defaults to disabled without carrying V1 server settings", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({});
      expect(settings).toEqual({ enabled: false, binaryPath: "opencode2", customModels: [] });
      const snapshot = yield* buildInitialOpenCode2ProviderSnapshot(settings);
      expect(snapshot.displayName).toBe("OpenCode 2");
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing V2 binary without probing the V1 SDK", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenCode2ProviderStatus(
        decodeSettings({ enabled: true, binaryPath: "/definitely/missing/opencode2" }),
        process.env,
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("opencode2");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers models without copying unverified options between them", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(makeMockBinary);
      const snapshot = yield* checkOpenCode2ProviderStatus(
        decodeSettings({ enabled: true, binaryPath }),
        process.env,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.length).toBeGreaterThan(0);
      expect(snapshot.models[0]?.slug).toBeTruthy();
      expect(
        snapshot.models.every((model) => model.capabilities?.optionDescriptors?.length === 0),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
