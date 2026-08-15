// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { OpenCode2Settings } from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";

import {
  opencode2PromptSettlementBelongsToContext,
  makeOpenCode2Adapter,
  parseOpenCode2Resume,
} from "./OpenCode2Adapter.ts";

const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
const testLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-opencode2-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const decodeSettings = Schema.decodeSync(OpenCode2Settings);

async function makeWrapper(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode2-acp-mock-"));
  const wrapper = NodePath.join(directory, "opencode2");
  await NodeFSP.writeFile(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapper, 0o755);
  return wrapper;
}

describe("OpenCode2Adapter", () => {
  it("accepts only the versioned resume cursor", () => {
    expect(parseOpenCode2Resume({ schemaVersion: 1, sessionId: "ses_123" })).toEqual({
      sessionId: "ses_123",
    });
    expect(parseOpenCode2Resume({ schemaVersion: 2, sessionId: "ses_123" })).toBeUndefined();
    expect(parseOpenCode2Resume({ schemaVersion: 1, sessionId: " " })).toBeUndefined();
  });

  it("rejects late prompt settlement from another session or turn", () => {
    expect(
      opencode2PromptSettlementBelongsToContext({
        liveAcpSessionId: "ses_live",
        expectedAcpSessionId: "ses_stale",
        liveActiveTurnId: "turn_1" as never,
        liveSessionActiveTurnId: "turn_1" as never,
        turnId: "turn_1" as never,
      }),
    ).toBe(false);
  });

  it.layer(testLayer)("ACP lifecycle", (it) => {
    it.effect("starts, prompts, maps events, and stops an ACP session", () =>
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(makeWrapper);
        const adapter = yield* makeOpenCode2Adapter(decodeSettings({ binaryPath }));
        const completed = yield* Deferred.make<void>();
        const events: Array<string> = [];
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event.type);
          }).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(completed, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);
        const threadId = ThreadId.make("opencode2-adapter-thread");
        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("opencode2"),
          providerInstanceId: ProviderInstanceId.make("opencode2"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode2"),
            model: "default",
          },
        });
        expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session-1" });
        yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
        yield* Deferred.await(completed);
        expect(events).toEqual(
          expect.arrayContaining([
            "session.started",
            "turn.started",
            "content.delta",
            "turn.completed",
          ]),
        );
        yield* Fiber.interrupt(eventFiber);
        yield* adapter.stopSession(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
