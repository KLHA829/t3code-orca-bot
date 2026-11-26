// @effect-diagnostics nodeBuiltinImport:off -- bot memory is a user-owned Markdown file; steps journal every read and append.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { issues, pullRequests } from "./forgeApi.ts";
import { checkOptions } from "./options.ts";
import {
  type OpenedTrigger,
  type ScheduleTrigger,
  Tick,
  type Trigger,
  WebhookRequest,
  type WebhookTrigger,
} from "./triggers.ts";
import { step, tags, title, within, workflow, type WorkflowDefinition } from "./workflow.ts";
import { agent } from "./workflowAgent.ts";
import type { AgentLaunch, AgentModel } from "./WorkflowAgents.ts";
import { Issue, PullRequest } from "./WorkflowForge.ts";

const EVENT_JSON_LIMIT = 20_000;
const MEMORY_CONTEXT_LIMIT = 64_000;

/** What the bot's agent returns for one job. Empty text means none of that output is needed. */
export const BotAgentResult = Schema.Struct({
  /** One sentence for the run list. */
  summary: Schema.String,
  /** What to post back on the issue or pull request the job came from. Empty posts nothing. */
  response: Schema.String,
  /** One durable fact to append to the bot's Markdown memory. Empty appends nothing. */
  memoryNote: Schema.optional(Schema.String),
});
export type BotAgentResult = typeof BotAgentResult.Type;

const isIssue = Schema.is(Issue);
const isPullRequest = Schema.is(PullRequest);
const isTick = Schema.is(Tick);
const isWebhookRequest = Schema.is(WebhookRequest);

interface BotEvent {
  readonly kind: "issue" | "pullRequest" | "webhook" | "schedule" | "message";
  readonly label: string;
  readonly origin: string;
  readonly message?: string | undefined;
}

const eventOf = (payload: Schema.Json): BotEvent => {
  if (isIssue(payload)) {
    return {
      kind: "issue",
      label: `${payload.displayKey} ${payload.title}`,
      origin: `A new issue was opened at ${payload.url}.`,
    };
  }
  if (isPullRequest(payload)) {
    return {
      kind: "pullRequest",
      label: `PR #${payload.number} ${payload.title}`,
      origin: `A new pull request was opened at ${payload.url}.`,
    };
  }
  if (isWebhookRequest(payload)) {
    return {
      kind: "webhook",
      label: `webhook ${payload.method}`,
      origin: "A webhook delivery arrived.",
    };
  }
  if (isTick(payload)) {
    return {
      kind: "schedule",
      label: `scheduled ${payload.scheduledAt.slice(0, 16)}`,
      origin: `A scheduled job was due at ${payload.scheduledAt}.`,
    };
  }
  const directMessage =
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "message" in payload &&
    typeof payload.message === "string"
      ? payload.message.trim()
      : "";
  return {
    kind: "message",
    label: directMessage === "" ? "message" : directMessage.slice(0, 80),
    origin: "A person asked the bot directly.",
    message: directMessage,
  };
};

const jsonForPrompt = (value: Schema.Json) => {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length <= EVENT_JSON_LIMIT
    ? text
    : `${text.slice(0, EVENT_JSON_LIMIT)}\n… ${text.length - EVENT_JSON_LIMIT} more characters`;
};

const memoryForPrompt = (memory: string) =>
  memory.length <= MEMORY_CONTEXT_LIMIT
    ? memory
    : memory.slice(memory.length - MEMORY_CONTEXT_LIMIT);

const readOptionalFile = async (file: string) => {
  try {
    return await NodeFSP.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

const BotContext = Schema.Struct({
  purpose: Schema.String,
  memory: Schema.String,
});

class BotContextReadError extends Schema.TaggedError<BotContextReadError>()("BotContextReadError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not read the bot's purpose or memory.";
  }
}

class BotMemoryWriteError extends Schema.TaggedError<BotMemoryWriteError>()("BotMemoryWriteError", {
  file: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not append to the bot's memory ${this.file}.`;
  }
}

const briefOf = (input: {
  readonly name: string;
  readonly purpose: string;
  readonly memory: string;
  readonly event: BotEvent;
  readonly payload: Schema.Json;
}) => `You are ${input.name}, a persistent coding bot running inside T3 Code.

## Purpose
${input.purpose.trim() || "No purpose has been written yet. Ask what the bot should do before making irreversible changes."}

## Markdown memory
${memoryForPrompt(input.memory).trim() || "No memory yet."}

## Job
${input.event.origin}

Payload, as JSON:
\`\`\`json
${jsonForPrompt(input.payload)}
\`\`\`
${input.event.kind === "message" ? "\nFor this direct message, payload.message is the person's new message. payload.conversation, when present, is the recent direct-message history, oldest first.\n" : ""}
Do the job in the project. When it needs a decision or approval that you cannot safely make, stop and explain what is needed instead of guessing. Return the structured result:
- summary: one sentence for the bot's run list
- response: for a direct message, the concise reply to the person; otherwise the concise comment to post back where this job came from, or an empty string when nothing should be posted
- memoryNote: one durable fact worth remembering across future jobs, or omit it when nothing is worth remembering

Do not include transient status in memoryNote. Never post secrets or credentials in response.`;

/** A trigger a bot can react to. The event payload is decoded by the bot itself. */
export type BotTrigger = ScheduleTrigger | WebhookTrigger | OpenedTrigger;

/**
 * Define an Orca-style bot as a durable workflow: a named agent with a purpose, Markdown memory,
 * and schedule, webhook, issue, pull request, or direct-message jobs. Replies to issue and pull
 * request jobs are posted back once, after the agent finishes.
 */
export const bot = (
  name: string,
  options: {
    readonly version?: number | undefined;
    /** The project id or absolute folder the bot works in. */
    readonly project: string;
    /** Who the bot is and what it does. */
    readonly purpose?: string | undefined;
    /** A Markdown file whose content is read as the bot's purpose for every run. */
    readonly purposeFile?: string | undefined;
    /** A Markdown file the bot can append durable facts to. */
    readonly memoryFile?: string | undefined;
    /** What starts jobs by itself. Direct jobs can always be started as workflow runs. */
    readonly triggers?: ReadonlyArray<BotTrigger> | undefined;
    /** Whether to post the agent's response on the originating issue or pull request. */
    readonly postReplies?: boolean | undefined;
    /** How many jobs this bot works on at once. */
    readonly concurrency?: number | undefined;
    /** How the bot's agent thread runs. */
    readonly agent?:
      | {
          readonly model?: AgentModel | undefined;
          readonly environment?: string | undefined;
          readonly timeout?: Duration.Input | undefined;
          readonly workspace?: AgentLaunch["workspace"] | undefined;
          readonly runtimeMode?: AgentLaunch["runtimeMode"] | undefined;
          readonly interactionMode?: AgentLaunch["interactionMode"] | undefined;
        }
      | undefined;
  },
): WorkflowDefinition<Schema.Json, unknown> => {
  checkOptions(`bot("${name}")`, options, [
    "version",
    "project",
    "purpose",
    "purposeFile",
    "memoryFile",
    "triggers",
    "postReplies",
    "concurrency",
    "agent",
  ]);
  checkOptions(`bot("${name}")'s agent`, options.agent, [
    "model",
    "environment",
    "timeout",
    "workspace",
    "runtimeMode",
    "interactionMode",
  ]);
  if (options.purpose === undefined && options.purposeFile === undefined) {
    throw new Error(`bot("${name}") needs a purpose or a purposeFile.`);
  }
  for (const file of [options.purposeFile, options.memoryFile]) {
    if (file !== undefined && !NodePath.isAbsolute(file)) {
      throw new Error(`bot("${name}") file paths must be absolute, not ${file}.`);
    }
  }

  return workflow(
    name,
    {
      version: options.version ?? 1,
      payload: Schema.Json,
      triggers: (options.triggers ?? []) as ReadonlyArray<Trigger<Schema.Json>>,
    },
    Effect.fn(function* (payload) {
      const event = eventOf(payload);
      yield* title(`${name}: ${event.label}`);
      yield* tags(["bot", `bot:${event.kind}`]);
      // Tag and name direct jobs before they queue, so a chat message stays visible while the bot is busy.
      const work = Effect.gen(function* () {
        const context = yield* step(
          "context",
          { returns: BotContext },
          Effect.tryPromise({
            try: async () => ({
              purpose: [
                options.purpose ?? "",
                options.purposeFile === undefined
                  ? ""
                  : await readOptionalFile(options.purposeFile),
              ]
                .filter((part) => part.trim().length > 0)
                .join("\n\n"),
              memory:
                options.memoryFile === undefined ? "" : await readOptionalFile(options.memoryFile),
            }),
            catch: (cause) => new BotContextReadError({ cause }),
          }),
        );
        const result = yield* agent("respond", {
          project: options.project,
          brief: briefOf({
            name,
            purpose: context.purpose,
            memory: context.memory,
            event,
            payload,
          }),
          returns: BotAgentResult,
          ...(isIssue(payload) ? { issue: payload } : {}),
          ...(options.agent?.model === undefined ? {} : { model: options.agent.model }),
          ...(options.agent?.environment === undefined
            ? {}
            : { environment: options.agent.environment }),
          ...(options.agent?.timeout === undefined ? {} : { timeout: options.agent.timeout }),
          ...(options.agent?.workspace === undefined ? {} : { workspace: options.agent.workspace }),
          ...(options.agent?.runtimeMode === undefined
            ? {}
            : { runtimeMode: options.agent.runtimeMode }),
          ...(options.agent?.interactionMode === undefined
            ? {}
            : { interactionMode: options.agent.interactionMode }),
        });

        const memoryNote = result.value.memoryNote?.trim() ?? "";
        if (memoryNote.length > 0 && options.memoryFile !== undefined) {
          const memoryFile = options.memoryFile;
          yield* step(
            "remember",
            { returns: Schema.Void },
            Effect.gen(function* () {
              const at = DateTime.formatIso(yield* DateTime.now);
              yield* Effect.tryPromise({
                try: async () => {
                  await NodeFSP.mkdir(NodePath.dirname(memoryFile), { recursive: true });
                  await NodeFSP.appendFile(memoryFile, `\n\n## ${at}\n\n${memoryNote}\n`);
                },
                catch: (cause) => new BotMemoryWriteError({ file: memoryFile, cause }),
              });
            }),
          );
        }

        const response = result.value.response.trim();
        if (response.length > 0 && options.postReplies !== false) {
          if (isIssue(payload)) {
            yield* step("reply", { returns: Schema.Void }, issues.comment(payload, response));
          } else if (isPullRequest(payload)) {
            yield* step("reply", { returns: Schema.Void }, pullRequests.comment(payload, response));
          }
        }

        return {
          summary: result.value.summary,
          response: result.value.response,
          event: event.kind,
          ...(event.message === undefined ? {} : { message: event.message }),
          thread: result.thread,
        };
      });
      // One job at a time by default keeps the bot's memory in the order it learned it.
      return yield* within(name, { limit: options.concurrency ?? 1 }, work);
    }),
  );
};
