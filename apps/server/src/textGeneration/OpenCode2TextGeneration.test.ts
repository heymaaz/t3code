// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OpenCode2Settings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  extractOpenCode2StructuredOutput,
  makeOpenCode2TextGeneration,
} from "./OpenCode2TextGeneration.ts";

const decodeSettings = Schema.decodeSync(OpenCode2Settings);
const encodeCommitResponse = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ subject: Schema.String, body: Schema.String })),
);
const decodeJsonRpcRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optionalKey(Schema.String),
      params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../scripts/acp-mock-agent.ts",
);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeMockBinary(directory: string, environment: Record<string, string>): string {
  const binaryPath = NodePath.join(directory, "opencode2");
  NodeFS.writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      ...Object.entries(environment).map(
        ([key, value]) => `export ${key}=${shellSingleQuote(value)}`,
      ),
      'if [ "$1" != "acp" ]; then exit 11; fi',
      `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

describe("OpenCode2TextGeneration", () => {
  it("extracts the existing structured JSON response from assistant text", () => {
    expect(extractOpenCode2StructuredOutput('I will respond with {"name":"feature"}.')).toBe(
      '{"name":"feature"}',
    );
  });

  it.effect("generates and decodes commit content through the ACP mock agent", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-opencode2-text-"),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const binaryPath = makeMockBinary(directory, {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: encodeCommitResponse({
          subject: "Add OpenCode 2 text generation",
          body: "Exercise model setup and structured output decoding.",
        }),
      });
      const textGeneration = yield* makeOpenCode2TextGeneration(
        decodeSettings({ enabled: true, binaryPath }),
      );

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode2-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/OpenCode2TextGeneration.ts",
        stagedPatch: "diff --git a/OpenCode2TextGeneration.ts b/OpenCode2TextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode2"), "composer-2"),
      });

      expect(generated).toEqual({
        subject: "Add OpenCode 2 text generation",
        body: "Exercise model setup and structured output decoding.",
      });
      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeJsonRpcRequest(line));
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "model" &&
            request.params?.value === "composer-2",
        ),
      ).toBe(true);
      expect(requests.some((request) => request.method === "session/prompt")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
