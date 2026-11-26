import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, type WorkflowRun } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { Command } from "effect/cli";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { botCommand, botFileSlug, botSlug, botTemplates, botWorkflowSource } from "./bot.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const runBotCli = (args: ReadonlyArray<string>) =>
  Command.runWith(botCommand, { version: "test" })(args).pipe(
    Effect.flip,
    Effect.orElseSucceed(() => undefined),
  );

const makeRun = (status: WorkflowRun["status"]): WorkflowRun => ({
  runId: "run-1",
  workflow: "bot-bug-bot",
  version: 1,
  title: "bot-bug-bot: message",
  status,
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  resumesAt: null,
  parentRunId: null,
  parentStep: null,
  startedAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
  endedAt: null,
});

const runAskCli = (args: ReadonlyArray<string>, call: McpBridge.McpToolSession["call"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-cli-" });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3_773,
      }),
    });
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, input) => {
          calls.push(input);
          return call(tool, input);
        },
      }),
    );
    const error = yield* Command.runWith(botCommand, { version: "test" })([
      ...args,
      "--base-dir",
      baseDir,
    ]).pipe(
      Effect.flip,
      Effect.orElseSucceed(() => undefined),
    );
    return { error, calls };
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  );

it.effect("bot workflow source carries the feature options", () =>
  Effect.sync(() => {
    const source = botWorkflowSource({
      slug: "gardener",
      project: "/tmp/project",
      purposeFile: "/tmp/bots/gardener/SOUL.md",
      memoryFile: "/tmp/bots/gardener/MEMORY.md",
      issues: false,
      pullRequests: false,
      reflection: true,
      confirmReplies: true,
      maxJobsPerDay: 5,
      notifyWebhook: "https://hooks.slack.com/services/test",
    });
    assert.include(source, "reflection: true");
    assert.include(source, "confirmReplies: true");
    assert.include(source, "maxJobsPerDay: 5");
    assert.include(source, 'notifyWebhook: "https://hooks.slack.com/services/test"');
    const plain = botWorkflowSource({
      slug: "plain",
      project: "/tmp/project",
      purposeFile: "/tmp/bots/plain/SOUL.md",
      memoryFile: "/tmp/bots/plain/MEMORY.md",
      issues: false,
      pullRequests: false,
    });
    assert.notInclude(plain, "reflection");
    assert.notInclude(plain, "confirmReplies");
    assert.notInclude(plain, "maxJobsPerDay");
    assert.notInclude(plain, "notifyWebhook");
  }),
);

it.effect("bot templates have a name, summary and purpose", () =>
  Effect.sync(() => {
    for (const [name, template] of Object.entries(botTemplates)) {
      assert.isAbove(name.length, 2);
      assert.isAbove(template.summary.length, 20);
      assert.isAbove(template.purpose.length, 100);
    }
    assert.isDefined(botTemplates["dependency-gardener"]);
  }),
);

it.effect("bot create with an unknown template is refused", () =>
  Effect.gen(function* () {
    const error = yield* runBotCli([
      "create",
      "helper",
      "--project",
      "project-1",
      "--template",
      "missing-template",
    ]);
    assert.include(String(error ?? ""), "Unknown template");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))),
);

it.effect("bot create without purpose or template is refused", () =>
  Effect.gen(function* () {
    const error = yield* runBotCli(["create", "helper", "--project", "project-1"]);
    assert.include(String(error ?? ""), "--purpose or --template");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))),
);

it.effect("bot slugs are file-safe and bounded", () =>
  Effect.sync(() => {
    assert.equal(botSlug("Bug Triage Bot"), "bug-triage-bot");
    assert.equal(botSlug("  issue+pr/helper  "), "issue-pr-helper");
    assert.equal(botSlug("---"), undefined);
    assert.equal(botSlug("助手"), "助手");
    assert.match(botFileSlug(botSlug("助手") ?? ""), /^unicode-[0-9a-f]{12}$/);
    assert.match(botFileSlug("助手-bot"), /^bot-[0-9a-f]{12}$/);
    assert.notEqual(botFileSlug("助手"), botFileSlug("幫手"));
    assert.equal(botSlug("Triage 🤖"), "triage");
    assert.match(botSlug(`${"a".repeat(60)}-tail`) ?? "", /^a{35}-[0-9a-f]{12}$/);
    assert.notEqual(botSlug(`${"a".repeat(60)}-tail`), botSlug(`${"a".repeat(60)}-other`));
  }),
);

it.effect("a generated bot workflow declares its memory, project, and triggers", () =>
  Effect.sync(() => {
    const source = botWorkflowSource({
      slug: "helper",
      project: "/repo",
      purposeFile: "/home/.t3/bots/helper/SOUL.md",
      memoryFile: "/home/.t3/bots/helper/MEMORY.md",
      model: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" },
      issues: true,
      pullRequests: false,
      every: "1 day",
      daily: undefined,
      webhook: "jobs",
    });
    assert.include(source, 'export default T3.bot("bot-helper"');
    assert.include(source, 'project: "/repo"');
    assert.include(source, 'purposeFile: "/home/.t3/bots/helper/SOUL.md"');
    assert.include(source, 'memoryFile: "/home/.t3/bots/helper/MEMORY.md"');
    assert.include(
      source,
      'agent: { model: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" } },',
    );
    assert.include(source, 'T3.issues.opened({ project: "/repo" })');
    assert.include(source, 'T3.every("1 day")');
    assert.include(source, 'T3.webhook("jobs")');
    assert.notInclude(source, "T3.pullRequests.opened");
  }),
);

it.effect("bot create rejects invalid project and schedule input before writing files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-invalid-" });
    const create = (extra: ReadonlyArray<string>) => [
      "create",
      "Bug Bot",
      "--project",
      "/repo",
      "--purpose",
      "Triage bugs.",
      "--base-dir",
      baseDir,
      ...extra,
    ];

    const relative = yield* runBotCli(
      create([]).map((part) => (part === "/repo" ? "apps/repo" : part)),
    );
    assert.equal(relative?._tag, "ThreadUsageError");
    assert.include(relative?.message ?? "", "relative path");

    const every = yield* runBotCli(create(["--every", "nonsense"]));
    assert.equal(every?._tag, "ThreadUsageError");
    assert.include(every?.message ?? "", "--every");

    const daily = yield* runBotCli(create(["--daily", "25:00"]));
    assert.equal(daily?._tag, "ThreadUsageError");
    assert.include(daily?.message ?? "", "--daily");
    assert.isFalse(yield* fs.exists(path.join(baseDir, "bots", "bug-bot")));
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
    Effect.scoped,
  ),
);

it.effect("bot create writes soul, memory, and workflow files without replacing memory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-" });
    const args = [
      "create",
      "Bug Bot",
      "--project",
      "/repo",
      "--purpose",
      "Triage bugs.",
      "--provider-instance",
      "claudeAgent",
      "--model",
      "claude-sonnet-4-5",
      "--issues",
      "--base-dir",
      baseDir,
    ];
    assert.equal(yield* runBotCli(args), undefined);

    const botDir = path.join(baseDir, "bots", "bug-bot");
    const soulFile = path.join(botDir, "SOUL.md");
    const memoryFile = path.join(botDir, "MEMORY.md");
    const workflowFile = path.join(baseDir, "workflows", "bot-bug-bot.ts");
    assert.include(yield* fs.readFileString(soulFile), "Triage bugs.");
    assert.include(yield* fs.readFileString(memoryFile), "# Bug Bot memory");
    const workflowSource = yield* fs.readFileString(workflowFile);
    assert.include(workflowSource, 'T3.issues.opened({ project: "/repo" })');
    assert.include(
      workflowSource,
      'agent: { model: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" } },',
    );

    yield* fs.writeFileString(memoryFile, "# Bug Bot memory\n\nKeep me.");
    assert.equal(yield* runBotCli([...args, "--force"]), undefined);
    assert.include(yield* fs.readFileString(memoryFile), "Keep me.");

    assert.equal(
      yield* runBotCli([
        "create",
        "助手",
        "--project",
        "/repo",
        "--purpose",
        "幫手做小事。",
        "--base-dir",
        baseDir,
      ]),
      undefined,
    );
    assert.isTrue(yield* fs.exists(path.join(baseDir, "bots", "助手", "SOUL.md")));
    const unicodeWorkflowFile = path.join(baseDir, "workflows", `bot-${botFileSlug("助手")}.ts`);
    assert.isTrue(yield* fs.exists(unicodeWorkflowFile));
    assert.include(yield* fs.readFileString(unicodeWorkflowFile), 'T3.bot("bot-助手"');

    assert.equal(yield* runBotCli(["list", "--base-dir", baseDir]), undefined);
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
    Effect.scoped,
  ),
);

it.effect("bot ask starts the bot's workflow with the message and key", () =>
  Effect.gen(function* () {
    const { error, calls } = yield* runAskCli(
      ["ask", "Bug Bot", "look at the regression", "--key", "ask-1"],
      () => Effect.succeed({ structuredContent: { run: makeRun("running"), steps: [] } }),
    );
    assert.isUndefined(error);
    assert.deepStrictEqual(calls, [
      {
        action: "start",
        workflow: "bot-bug-bot",
        input: { message: "look at the regression" },
        idempotencyKey: "ask-1",
      },
    ]);
  }),
);
