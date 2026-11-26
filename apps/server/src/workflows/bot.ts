// @effect-diagnostics nodeBuiltinImport:off -- bot memory is a user-owned Markdown file; steps journal every read and append.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import { issues, pullRequests } from "./forgeApi.ts";
import { Runs, store } from "./stepServices.ts";
import { checkOptions } from "./options.ts";
import {
  type OpenedTrigger,
  type ScheduleTrigger,
  Tick,
  type Trigger,
  WebhookRequest,
  type WebhookTrigger,
} from "./triggers.ts";
import {
  RunContext,
  step,
  skip,
  stop,
  tags,
  title,
  within,
  workflow,
  type WorkflowDefinition,
} from "./workflow.ts";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import { memoryForJob } from "./botMemory.ts";
import { agent, ask } from "./workflowAgent.ts";
import type { AgentLaunch, AgentModel } from "./WorkflowAgents.ts";
import { Issue, PullRequest } from "./WorkflowForge.ts";

const EVENT_JSON_LIMIT = 20_000;
const PURPOSE_CONTEXT_LIMIT = 64_000;
const MEMORY_CONTEXT_LIMIT = 64_000;

/** What the bot's agent returns for one job. Empty text means none of that output is needed. */
export const BotAgentResult = Schema.Struct({
  /** One sentence for the run list. */
  summary: Schema.String,
  /** What to post back on the issue or pull request the job came from. Empty posts nothing. */
  response: Schema.String,
  /** One durable fact to append to the bot's Markdown memory. Empty appends nothing. */
  memoryNote: Schema.optional(Schema.String),
  /** Jobs for teammate bots, when the brief lists teammates. At most three are started. */
  handoffs: Schema.optional(
    Schema.Array(Schema.Struct({ bot: Schema.String, message: Schema.String })),
  ),
});

/** What the bot's reflection pass returns: one generalized lesson, or empty for none. */
export const BotReflection = Schema.Struct({
  lesson: Schema.String,
});
export type BotReflection = typeof BotReflection.Type;
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

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);

const directModelOf = (payload: Schema.Json): ModelSelection | null | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("model" in payload)
  ) {
    return undefined;
  }
  if (payload.model === null) return null;
  try {
    return decodeModelSelection(payload.model);
  } catch {
    return undefined;
  }
};

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

const purposeForPrompt = (purpose: string) =>
  purpose.length <= PURPOSE_CONTEXT_LIMIT ? purpose : purpose.slice(0, PURPOSE_CONTEXT_LIMIT);

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
  model: Schema.optional(ModelSelection),
  teammates: Schema.Array(Schema.String),
  jobsToday: Schema.optional(Schema.Number),
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

class BotNotifyError extends Schema.TaggedError<BotNotifyError>()("BotNotifyError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not post the bot's notification.";
  }
}

const briefOf = (input: {
  readonly name: string;
  readonly purpose: string;
  readonly memory: string;
  readonly event: BotEvent;
  readonly payload: Schema.Json;
  readonly teammates: ReadonlyArray<string>;
}) => `You are ${input.name}, a persistent coding bot running inside T3 Code.

## Purpose
${input.purpose.trim() || "No purpose has been written yet. Ask what the bot should do before making irreversible changes."}

## Markdown memory
${input.memory.trim() || "No memory yet."}
${
  input.teammates.length === 0
    ? ""
    : `
## Team
These teammate bots exist in this T3 home: ${input.teammates.join(", ")}. When part of the job belongs to one of them, hand it off instead of doing it yourself.
`
}
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
${input.teammates.length === 0 ? "" : "- handoffs: at most 3 handoffs as { bot, message }, one per teammate bot that should pick up part of this work. bot is the teammate's name. Omit it when nothing needs handing off.\n"}
Do not include transient status in memoryNote. Never post secrets or credentials in response. Never merge, force-push, delete branches, or publish releases unless the job explicitly asks for exactly that.`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A GitHub webhook delivery, when the payload is one: the event name and its decoded body. */
const githubWebhookOf = (
  payload: Schema.Json,
): { readonly event: string; readonly json: Record<string, unknown> } | undefined => {
  if (!isWebhookRequest(payload)) return undefined;
  const event = payload.headers["x-github-event"];
  if (event === undefined) return undefined;
  try {
    const json: unknown = JSON.parse(payload.body);
    if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
    return { event, json: json as Record<string, unknown> };
  } catch {
    return undefined;
  }
};

const objectAt = (json: Record<string, unknown>, key: string) => {
  const value = json[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const stringAt = (json: Record<string, unknown> | undefined, key: string) =>
  json !== undefined && typeof json[key] === "string" ? (json[key] as string) : undefined;

/** What a GitHub delivery means for the bot: a mention to answer, a CI failure to fix, or noise. */
const githubJobOf = (
  github: { readonly event: string; readonly json: Record<string, unknown> },
  name: string,
):
  | { readonly kind: "mention"; readonly issueUrl: string; readonly label: string }
  | { readonly kind: "ci-failure"; readonly label: string }
  | { readonly kind: "noise"; readonly reason: string } => {
  const { event, json } = github;
  if (event === "issue_comment") {
    const comment = objectAt(json, "comment");
    const issue = objectAt(json, "issue");
    const body = stringAt(comment, "body") ?? "";
    const slug = name.startsWith("bot-") ? name.slice(4) : name;
    const mention = new RegExp(`@${escapeRegExp(slug)}(?:-bot)?\\b|@bot\\b`, "i").test(body);
    if (json.action !== "created" || !mention) {
      return { kind: "noise", reason: "The comment does not mention this bot." };
    }
    const number = typeof issue?.number === "number" ? `#${issue.number}` : "the issue";
    return {
      kind: "mention",
      issueUrl: stringAt(issue, "html_url") ?? "",
      label: `mention on ${number}`,
    };
  }
  if (event === "check_suite" || event === "check_run" || event === "workflow_run") {
    const subject = objectAt(json, event) ?? {};
    const conclusion = stringAt(subject, "conclusion");
    if (json.action !== "completed" || conclusion !== "failure") {
      return { kind: "noise", reason: "The check did not fail." };
    }
    const checkName = stringAt(subject, "name") ?? event;
    return { kind: "ci-failure", label: `CI failure: ${checkName}` };
  }
  return { kind: "noise", reason: `Nothing to do for a GitHub ${event} delivery.` };
};

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
    /** Ask a person to approve each issue or pull request reply before it is posted. */
    readonly confirmReplies?: boolean | undefined;
    /** After each job, ask the same agent thread for one generalized lesson and remember it. */
    readonly reflection?: boolean | undefined;
    /** Stop jobs once this many have started in one UTC day. */
    readonly maxJobsPerDay?: number | undefined;
    /** Post run notifications to this Slack or Discord incoming webhook URL. */
    readonly notifyWebhook?: string | undefined;
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
    "confirmReplies",
    "reflection",
    "maxJobsPerDay",
    "notifyWebhook",
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
  if (options.maxJobsPerDay !== undefined) {
    if (!Number.isInteger(options.maxJobsPerDay) || options.maxJobsPerDay < 1) {
      throw new Error(`bot("${name}") maxJobsPerDay is a positive whole number.`);
    }
  }
  if (options.notifyWebhook !== undefined) {
    const protocol = URL.parse(options.notifyWebhook)?.protocol;
    if (protocol !== "https:" && protocol !== "http:") {
      throw new Error(`bot("${name}")'s notifyWebhook is an http or https URL.`);
    }
  }

  const modelStore = store.entry(`bot:${name}:model`, ModelSelection);

  /** Best-effort Slack or Discord incoming-webhook notice, journaled so it posts once. */
  const notifyStep = (stepName: string, text: string) => {
    const webhook = options.notifyWebhook;
    if (webhook === undefined) return Effect.void;
    return step(
      stepName,
      { returns: Schema.Void },
      // Steps cannot require HttpClient (it is outside the step context), so the webhook goes
      // out with node:http directly. The post is journaled: a replayed run does not notify twice.
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            const url = new URL(webhook);
            const transport = url.protocol === "https:" ? NodeHttps : NodeHttp;
            // Slack reads `text`, Discord reads `content`; both ignore the other key.
            const body = `${JSON.stringify({ text, content: text })}`;
            const request = transport.request(
              url,
              {
                method: "POST",
                headers: { "content-type": "application/json", "content-length": body.length },
                timeout: 10_000,
              },
              (response) => {
                response.resume();
                response.once("end", () => {
                  if ((response.statusCode ?? 500) < 300) resolve();
                  else reject(new Error(`webhook answered ${response.statusCode ?? 500}`));
                });
                response.once("error", reject);
              },
            );
            request.once("timeout", () => request.destroy(new Error("webhook timed out")));
            request.once("error", reject);
            request.end(body);
          }),
        catch: (cause) => new BotNotifyError({ cause }),
      }).pipe(Effect.ignore),
    );
  };

  return workflow(
    name,
    {
      version: options.version ?? 1,
      payload: Schema.Json,
      triggers: (options.triggers ?? []) as ReadonlyArray<Trigger<Schema.Json>>,
    },
    Effect.fn(function* (payload) {
      const github = githubWebhookOf(payload);
      const githubJob = github === undefined ? undefined : githubJobOf(github, name);
      const event =
        githubJob !== undefined && githubJob.kind !== "noise"
          ? {
              kind: "webhook" as const,
              label: githubJob.label,
              origin:
                githubJob.kind === "mention"
                  ? "Someone mentioned this bot in a comment. The comment and its context are in the payload; answer what it asks."
                  : "A CI check failed. The failure details are in the payload; diagnose and fix the cause in the project.",
            }
          : eventOf(payload);
      const directModel = directModelOf(payload);
      yield* title(`${name}: ${event.label}`);
      yield* tags(["bot", `bot:${event.kind}`]);
      // Tag and name direct jobs before they queue, so a chat message stays visible while the bot is busy.
      const work = Effect.gen(function* () {
        if (githubJob?.kind === "noise") {
          return yield* skip(githubJob.reason);
        }
        const context = yield* step(
          "context",
          { returns: BotContext },
          Effect.gen(function* () {
            const files = yield* Effect.tryPromise({
              try: async () => ({
                purpose: purposeForPrompt(
                  [
                    options.purpose ?? "",
                    options.purposeFile === undefined
                      ? ""
                      : await NodeFSP.readFile(options.purposeFile, "utf8"),
                  ]
                    .filter((part) => part.trim().length > 0)
                    .join("\n\n"),
                ),

                memory:
                  options.memoryFile === undefined
                    ? ""
                    : memoryForJob(
                        await readOptionalFile(options.memoryFile),
                        `${event.label}\n${event.message ?? ""}\n${event.origin}`,
                        { maxChars: MEMORY_CONTEXT_LIMIT },
                      ),
              }),
              catch: (cause) => new BotContextReadError({ cause }),
            });
            const teammates = yield* Effect.tryPromise({
              try: async () => {
                if (options.memoryFile === undefined) return [] as string[];
                // Generated bots live in bots/<slug>/MEMORY.md; sibling directories are its team.
                const botDirectory = NodePath.dirname(options.memoryFile);
                const botsRoot = NodePath.dirname(botDirectory);
                if (NodePath.basename(botsRoot) !== "bots") return [] as string[];
                const entries = await NodeFSP.readdir(botsRoot, { withFileTypes: true });
                const self = NodePath.basename(botDirectory);
                return entries
                  .filter((entry) => entry.isDirectory() && entry.name !== self)
                  .map((entry) => entry.name)
                  .sort();
              },
              catch: () => null,
            }).pipe(Effect.orElseSucceed(() => [] as string[]));
            let jobsToday: number | undefined;
            if (options.maxJobsPerDay !== undefined) {
              const day = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
              const jobsStore = store.entry(`bot:${name}:jobs:${day}`, Schema.Number);
              const count = yield* jobsStore.update(
                (current) => (Option.getOrUndefined(current) ?? 0) + 1,
              );
              jobsToday = Option.getOrUndefined(count) ?? 1;
            }
            const storedModel = yield* modelStore.update((current) =>
              directModel === null ? undefined : (directModel ?? Option.getOrUndefined(current)),
            );
            const model = directModel ?? Option.getOrUndefined(storedModel) ?? options.agent?.model;
            return {
              ...files,
              teammates,
              ...(jobsToday === undefined ? {} : { jobsToday }),
              ...(model === undefined
                ? {}
                : {
                    model: {
                      instanceId: ProviderInstanceId.make(model.instanceId),
                      model: model.model,
                      ...(model.options === undefined ? {} : { options: model.options }),
                    },
                  }),
            };
          }),
        );
        if (
          options.maxJobsPerDay !== undefined &&
          (context.jobsToday ?? 0) > options.maxJobsPerDay
        ) {
          return yield* stop(
            `Daily budget reached: ${options.maxJobsPerDay} jobs already started today.`,
          );
        }
        const result = yield* agent("respond", {
          project: options.project,
          brief: briefOf({
            name,
            purpose: context.purpose,
            memory: context.memory,
            event,
            payload,
            teammates: context.teammates,
          }),
          returns: BotAgentResult,
          ...(isIssue(payload) ? { issue: payload } : {}),
          ...(context.model === undefined ? {} : { model: context.model }),
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

        if (options.reflection === true) {
          const reflection = yield* agent("reflect", {
            project: options.project,
            brief: `You just completed a job as ${name}, a persistent coding bot.\n\nThe job: ${event.label}\nWhat you returned: ${result.value.summary}\n\nReflect on how it went. A useful lesson is generalizable: a mistake to avoid, a convention of this project you confirmed, a workflow that worked. Transient status is not a lesson. Return the structured result:\n- lesson: one durable lesson worth remembering, or an empty string when nothing generalizes`,
            returns: BotReflection,
            thread: result.thread,
            ...(context.model === undefined ? {} : { model: context.model }),
            ...(options.agent?.timeout === undefined ? {} : { timeout: options.agent.timeout }),
          });
          const lesson = reflection.value.lesson.trim();
          if (lesson.length > 0 && options.memoryFile !== undefined) {
            const memoryFile = options.memoryFile;
            yield* step(
              "remember-lesson",
              { returns: Schema.Void },
              Effect.gen(function* () {
                const at = DateTime.formatIso(yield* DateTime.now);
                yield* Effect.tryPromise({
                  try: async () => {
                    await NodeFSP.mkdir(NodePath.dirname(memoryFile), { recursive: true });
                    await NodeFSP.appendFile(memoryFile, `\n\n## ${at}\n\n${lesson}\n`);
                  },
                  catch: (cause) => new BotMemoryWriteError({ file: memoryFile, cause }),
                });
              }),
            );
          }
        }

        const response = result.value.response.trim();
        const mentionIssueUrl =
          githubJob?.kind === "mention" && githubJob.issueUrl !== ""
            ? githubJob.issueUrl
            : undefined;
        const replyTarget =
          isIssue(payload) || isPullRequest(payload) || mentionIssueUrl !== undefined;
        let postApproved = true;
        if (
          response.length > 0 &&
          options.postReplies !== false &&
          options.confirmReplies === true &&
          replyTarget
        ) {
          yield* notifyStep(
            "notify-approval",
            `${name} is waiting for reply approval on ${event.label}.`,
          );
          const answer = yield* ask("approve-reply", {
            title: `${name} wants to post this reply on ${event.label}. Post it?`,
            choices: [
              { value: "post", description: "Post the reply as written." },
              { value: "skip", description: "Do not post anything." },
            ],
            data: { body: response },
          });
          postApproved = Option.isSome(answer) && answer.value.choice === "post";
        }
        if (response.length > 0 && options.postReplies !== false && postApproved) {
          if (isIssue(payload)) {
            yield* step("reply", { returns: Schema.Void }, issues.comment(payload, response));
          } else if (isPullRequest(payload)) {
            yield* step("reply", { returns: Schema.Void }, pullRequests.comment(payload, response));
          } else if (mentionIssueUrl !== undefined) {
            yield* step(
              "reply",
              { returns: Schema.Void },
              issues.comment({ project: options.project, url: mentionIssueUrl }, response),
            );
          }
        }

        const slugOf = (botName: string) =>
          botName.startsWith("bot-") ? botName.slice(4) : botName;
        const handoffs = (result.value.handoffs ?? [])
          .filter((handoff) => {
            const slug = slugOf(handoff.bot);
            return slug !== "" && context.teammates.includes(slug) && `bot-${slug}` !== name;
          })
          .slice(0, 3);
        if (handoffs.length > 0) {
          const parentRunId = (yield* RunContext).runId;
          yield* step(
            "delegate",
            { returns: Schema.Void },
            Effect.gen(function* () {
              const runsService = yield* Runs;
              for (const [index, handoff] of handoffs.entries()) {
                const target = `bot-${slugOf(handoff.bot)}`;
                yield* runsService
                  .start(
                    target,
                    { message: handoff.message },
                    { idempotencyKey: `${parentRunId}/handoff/${index}` },
                  )
                  .pipe(Effect.ignore);
              }
            }),
          );
        }

        yield* notifyStep(
          "notify-completion",
          `${name} finished ${event.label}: ${result.value.summary}`,
        );

        return {
          summary: result.value.summary,
          response: result.value.response,
          event: event.kind,
          ...(event.message === undefined ? {} : { message: event.message }),
          ...(event.kind === "message" && context.model !== undefined
            ? { model: context.model }
            : {}),
          thread: result.thread,
        };
      });
      // One job at a time by default keeps the bot's memory in the order it learned it.
      return yield* within(name, { limit: options.concurrency ?? 1 }, work);
    }),
  );
};
