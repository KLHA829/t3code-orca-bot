// @effect-diagnostics nodeBuiltinImport:off - bot file slugs use a synchronous stable hash.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { isExplicitRelativePath } from "@t3tools/shared/path";

import { resolveBaseDir } from "../os-jank.ts";
import { parseTimeOfDay } from "../scheduledTasks/Schedule.ts";
import { isProjectPath } from "../workflows/WorkflowAgents.ts";
import { WorkflowRun, WorkflowStep } from "../workflows/WorkflowStore.ts";
import { projectLocationFlags } from "./config.ts";
import {
  jsonFlag,
  printJson,
  reportThreadErrors,
  ThreadUsageError,
  withThreadTools,
} from "./thread.ts";

const stableHash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);

/** The slug of a bot's display name, or undefined when it has no letters or digits. */
export const botSlug = (name: string) => {
  const separated = name
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (separated === "") return undefined;
  const characters = Array.from(separated);
  if (characters.length <= 48) return separated;
  // A hash of the whole slug keeps long names that share their first words apart.
  return `${characters.slice(0, 35).join("").replace(/-+$/g, "")}-${stableHash(separated)}`;
};

/**
 * The ASCII file name for a bot slug. Workflow definition files stay ASCII for portability;
 * a non-ASCII slug keeps a hash of the whole slug so distinct bot names do not collapse together.
 */
export const botFileSlug = (slug: string) => {
  const separated = slug
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/[^\x00-\x7f]/.test(slug)) return separated;
  const hash = stableHash(slug);
  const base = Array.from(separated === "" ? "unicode" : separated)
    .slice(0, 35)
    .join("")
    .replace(/-+$/g, "");
  return `${base === "" ? "unicode" : base}-${hash}`;
};

/** A named starting point for a bot's purpose. Users edit the generated SOUL.md after creation. */
export const botTemplates = {
  "issue-triager": {
    summary: "Triage newly opened issues: reproduce, label, and ask what is missing.",
    purpose: `You triage newly opened issues. For each one: read it carefully, check whether it has enough detail to act on, and look for duplicates in the tracker. Ask the reporter a precise clarifying question when something important is missing. Post one concise triage comment: what you understood, what seems most likely, and what happens next. Never close anyone's issue.`,
  },
  "pr-reviewer": {
    summary: "Review newly opened pull requests and post one focused review comment.",
    purpose: `You review newly opened pull requests. Read the diff and the surrounding code before judging anything. Check correctness, regressions, missing tests, and whether the change matches its description. Post one concise review comment: what looks good, what must change before merge, and what is optional. Be direct and specific; cite files and lines.`,
  },
  "security-reviewer": {
    summary: "Audit pull requests and the project for security problems.",
    purpose: `You are a security reviewer. For each pull request, look for injection, secret leakage, unsafe deserialization, broken access control, dependency risk, and insecure defaults. Only report findings you have verified in the code yourself, with file and line evidence. Rate each finding's severity honestly. Never post a finding you are unsure about without saying so.`,
  },
  "dependency-gardener": {
    summary: "Nightly maintenance: update dependencies, prune dead code, and fill test gaps.",
    purpose: `You are the project's maintenance gardener. Each night, pick one small, reversible maintenance task: update a stale dependency, remove clearly dead code, add a missing test for fragile logic, or fix a lint or typecheck warning. Verify your work with the project's own checks before finishing. Small and correct beats large and clever. Hand off anything risky instead of forcing it. Combine with a daily schedule, such as --daily 06:00.`,
  },
  "docs-keeper": {
    summary: "Keep documentation accurate when code or issues reveal drift.",
    purpose: `You keep documentation honest. When a job arrives, compare what the docs say with what the code actually does. Fix small inaccuracies directly. For large gaps, write one concise summary of what is wrong and where. Never document implementation details that will drift; document decisions, constraints, and how to accomplish tasks.`,
  },
} as const;

export type BotTemplateName = keyof typeof botTemplates;

/** The workflow file a created bot runs from. Workflow files import nothing from T3 itself. */
export const botWorkflowSource = (input: {
  readonly slug: string;
  readonly project: string;
  readonly purposeFile: string;
  readonly memoryFile: string;
  readonly model?: { readonly instanceId: string; readonly model: string } | undefined;
  readonly issues: boolean;
  readonly pullRequests: boolean;
  readonly every?: string | undefined;
  readonly daily?: string | undefined;
  readonly webhook?: string | undefined;
  readonly reflection?: boolean | undefined;
  readonly confirmReplies?: boolean | undefined;
  readonly maxJobsPerDay?: number | undefined;
  readonly notifyWebhook?: string | undefined;
}) => {
  const project = JSON.stringify(input.project);
  const triggers = [
    ...(input.issues ? [`T3.issues.opened({ project: ${project} })`] : []),
    ...(input.pullRequests ? [`T3.pullRequests.opened({ project: ${project} })`] : []),
    ...(input.every === undefined ? [] : [`T3.every(${JSON.stringify(input.every)})`]),
    ...(input.daily === undefined ? [] : [`T3.daily(${JSON.stringify(input.daily)})`]),
    ...(input.webhook === undefined ? [] : [`T3.webhook(${JSON.stringify(input.webhook)})`]),
  ];
  const triggerSource = triggers.length === 0 ? "[]" : `[\n    ${triggers.join(",\n    ")},\n  ]`;
  const agentSource =
    input.model === undefined
      ? ""
      : `  agent: { model: { instanceId: ${JSON.stringify(input.model.instanceId)}, model: ${JSON.stringify(input.model.model)} } },\n`;
  const featuresSource = [
    input.reflection === true ? "  reflection: true," : "",
    input.confirmReplies === true ? "  confirmReplies: true," : "",
    input.maxJobsPerDay === undefined ? "" : `  maxJobsPerDay: ${input.maxJobsPerDay},`,
    input.notifyWebhook === undefined
      ? ""
      : `  notifyWebhook: ${JSON.stringify(input.notifyWebhook)},`,
  ]
    .filter((line) => line !== "")
    .join("\n");
  return `// Generated by \`t3 bot create\`. Edit the bot's SOUL.md and MEMORY.md rather than
// duplicating them here; this file is where schedules, event triggers, and the model live.
export default T3.bot(${JSON.stringify(`bot-${input.slug}`)}, {
  version: 1,
  project: ${project},
  purposeFile: ${JSON.stringify(input.purposeFile)},
  memoryFile: ${JSON.stringify(input.memoryFile)},
${agentSource}${featuresSource === "" ? "" : `${featuresSource}\n`}  triggers: ${triggerSource},
});
`;
};

const soulSource = (name: string, purpose: string) => `# ${name}

${purpose}

## Operating principles

- Do small, reversible work first.
- Ask before destructive or irreversible actions.
- Report back where the job came from.
- Write down only durable facts in memory, never secrets.
`;

const memorySource = (name: string) => `# ${name} memory

Durable facts the bot learns across jobs are appended here.
`;

const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

const WorkflowStartResult = Schema.Struct({
  run: WorkflowRun,
  steps: Schema.Array(WorkflowStep),
});

const createCommand = Command.make("create", {
  ...projectLocationFlags,
  name: Argument.String("name").pipe(Argument.withDescription("Bot name.")),
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or absolute folder the bot works in."),
  ),
  purpose: Flag.String("purpose").pipe(
    Flag.withDescription("Who the bot is and what it does, written to SOUL.md."),
    Flag.optional,
  ),
  template: Flag.String("template").pipe(
    Flag.withDescription("Start from a named purpose template. `t3 bot templates` lists them."),
    Flag.optional,
  ),
  reflect: Flag.Boolean("reflect").pipe(
    Flag.withDescription("After each job, reflect on it and remember one generalized lesson."),
    Flag.withDefault(false),
  ),
  confirmReplies: Flag.Boolean("confirm-replies").pipe(
    Flag.withDescription("Ask a person to approve every issue or pull request reply."),
    Flag.withDefault(false),
  ),
  maxJobsPerDay: Flag.String("max-jobs-per-day").pipe(
    Flag.withDescription("Stop jobs once this many have started in one day."),
    Flag.optional,
  ),
  notifyWebhook: Flag.String("notify-webhook").pipe(
    Flag.withDescription("Post run notifications to this Slack or Discord incoming webhook URL."),
    Flag.optional,
  ),
  providerInstance: Flag.String("provider-instance").pipe(
    Flag.withDescription('Provider instance the bot uses, such as "claudeAgent" or "codex".'),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model the bot uses on that provider instance."),
    Flag.optional,
  ),
  issues: Flag.Boolean("issues").pipe(
    Flag.withDescription("Start a job for each newly opened issue in the project's tracker."),
    Flag.withDefault(false),
  ),
  pullRequests: Flag.Boolean("pull-requests").pipe(
    Flag.withDescription(
      "Start a job for each newly opened pull request in the project's repository.",
    ),
    Flag.withDefault(false),
  ),
  every: Flag.String("every").pipe(
    Flag.withDescription('Run on an interval, such as "1 hour" or "1 day".'),
    Flag.optional,
  ),
  daily: Flag.String("daily").pipe(
    Flag.withDescription('Run at a local time of day, such as "09:00".'),
    Flag.optional,
  ),
  webhook: Flag.String("webhook").pipe(
    Flag.withDescription("Create a named webhook trigger. `t3 workflow hooks` prints its URL."),
    Flag.optional,
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription("Replace the generated soul and workflow files. Memory is always kept."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create an Orca-style bot backed by a durable workflow."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const slug = botSlug(flags.name);
      if (slug === undefined) {
        return yield* new ThreadUsageError({ detail: "The bot name needs a letter or digit." });
      }
      if (Option.isSome(flags.providerInstance) !== Option.isSome(flags.model)) {
        return yield* new ThreadUsageError({
          detail: "Pass --provider-instance and --model together, or neither.",
        });
      }
      const template = Option.isSome(flags.template)
        ? (botTemplates as Record<string, (typeof botTemplates)[BotTemplateName]>)[
            flags.template.value
          ]
        : undefined;
      if (Option.isSome(flags.template) && template === undefined) {
        return yield* new ThreadUsageError({
          detail: `Unknown template "${flags.template.value}". \`t3 bot templates\` lists them.`,
        });
      }
      if (Option.isNone(flags.purpose) && template === undefined) {
        return yield* new ThreadUsageError({
          detail: "Pass --purpose or --template.",
        });
      }
      const purpose = [
        ...(template === undefined ? [] : [template.purpose]),
        ...(Option.isSome(flags.purpose) ? [flags.purpose.value] : []),
      ].join("\n\n");
      const maxJobsPerDay = Option.isSome(flags.maxJobsPerDay)
        ? Number(flags.maxJobsPerDay.value)
        : undefined;
      if (maxJobsPerDay !== undefined && (!Number.isInteger(maxJobsPerDay) || maxJobsPerDay < 1)) {
        return yield* new ThreadUsageError({
          detail: "Pass --max-jobs-per-day as a positive whole number.",
        });
      }
      if (Option.isSome(flags.notifyWebhook)) {
        const protocol = URL.parse(flags.notifyWebhook.value)?.protocol;
        if (protocol !== "https:" && protocol !== "http:") {
          return yield* new ThreadUsageError({
            detail: "Pass --notify-webhook as an http or https URL.",
          });
        }
      }
      if (
        (isExplicitRelativePath(flags.project) ||
          flags.project.includes("/") ||
          flags.project.includes("\\")) &&
        !isProjectPath(flags.project)
      ) {
        return yield* new ThreadUsageError({
          detail: "The project must be a project id or an absolute folder, not a relative path.",
        });
      }
      if (Option.isSome(flags.every)) {
        const everyMs = Option.map(
          Duration.fromInput(flags.every.value as Duration.Input),
          Duration.toMillis,
        );
        if (Option.isNone(everyMs) || everyMs.value < 60_000) {
          return yield* new ThreadUsageError({
            detail: 'Pass --every as a duration of at least one minute, such as "1 hour".',
          });
        }
      }
      if (Option.isSome(flags.daily) && parseTimeOfDay(flags.daily.value) === null) {
        return yield* new ThreadUsageError({
          detail: 'Pass --daily as a 24-hour time such as "09:00".',
        });
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir));
      const botDir = path.join(baseDir, "bots", slug);
      const workflowsDir = path.join(baseDir, "workflows");
      const soulFile = path.join(botDir, "SOUL.md");
      const memoryFile = path.join(botDir, "MEMORY.md");
      const workflowFile = path.join(workflowsDir, `bot-${botFileSlug(slug)}.ts`);
      const exists = yield* Effect.forEach(
        [soulFile, workflowFile],
        (file) => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
        { concurrency: 2 },
      );
      if (!flags.force && exists.some(Boolean)) {
        return yield* new ThreadUsageError({
          detail: `Bot ${slug} already exists. Pass --force to replace its generated files.`,
        });
      }
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.makeDirectory(workflowsDir, { recursive: true });
      yield* fs.writeFileString(soulFile, soulSource(flags.name, purpose));
      if (!(yield* fs.exists(memoryFile).pipe(Effect.orElseSucceed(() => false)))) {
        yield* fs.writeFileString(memoryFile, memorySource(flags.name));
      }
      yield* fs.writeFileString(
        workflowFile,
        botWorkflowSource({
          slug,
          project: flags.project,
          purposeFile: soulFile,
          memoryFile,
          ...(Option.isSome(flags.providerInstance) && Option.isSome(flags.model)
            ? {
                model: {
                  instanceId: flags.providerInstance.value,
                  model: flags.model.value,
                },
              }
            : {}),
          issues: flags.issues,
          pullRequests: flags.pullRequests,
          ...(Option.isSome(flags.every) ? { every: flags.every.value } : {}),
          ...(Option.isSome(flags.daily) ? { daily: flags.daily.value } : {}),
          ...(Option.isSome(flags.webhook) ? { webhook: flags.webhook.value } : {}),
          ...(flags.reflect ? { reflection: true } : {}),
          ...(flags.confirmReplies ? { confirmReplies: true } : {}),
          ...(maxJobsPerDay === undefined ? {} : { maxJobsPerDay }),
          ...(Option.isSome(flags.notifyWebhook)
            ? { notifyWebhook: flags.notifyWebhook.value }
            : {}),
        }),
      );
      const created = { name: slug, soulFile, memoryFile, workflowFile };
      if (flags.json) return yield* printJson(created);
      yield* Console.log(`Created ${slug}.`);
      yield* Console.log(`  Soul:     ${soulFile}`);
      yield* Console.log(`  Memory:   ${memoryFile}`);
      yield* Console.log(`  Workflow: ${workflowFile}`);
      yield* Console.log(
        `Ask it with: t3 bot ask ${slug} "your job" --base-dir ${quoteShell(baseDir)}`,
      );
    }).pipe(reportThreadErrors),
  ),
);

interface ListedBot {
  readonly name: string;
  readonly purpose: string;
  readonly directory: string;
}

const purposeOf = (soul: string) =>
  soul
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#")) ?? "";

const listCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List bots created in this T3 home."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir));
      const root = path.join(baseDir, "bots");
      const entries = yield* fs
        .readDirectory(root)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      const bots: Array<ListedBot> = [];
      for (const entry of entries.toSorted()) {
        const directory = path.join(root, entry);
        const soul = yield* fs
          .readFileString(path.join(directory, "SOUL.md"))
          .pipe(Effect.orElseSucceed(() => ""));
        bots.push({ name: entry, purpose: purposeOf(soul), directory });
      }
      if (flags.json) return yield* printJson(bots);
      if (bots.length === 0) {
        yield* Console.log("No bots yet. Create one with `t3 bot create`.");
        return;
      }
      for (const bot of bots) {
        yield* Console.log(`${bot.name}${bot.purpose === "" ? "" : `  ${bot.purpose}`}`);
      }
    }).pipe(reportThreadErrors),
  ),
);

const templatesCommand = Command.make("templates", {
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the purpose templates a bot can start from."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const templates = Object.entries(botTemplates).map(([name, { summary }]) => ({
        name,
        summary,
      }));
      if (flags.json) return yield* printJson(templates);
      for (const { name, summary } of templates) {
        yield* Console.log(`${name}\n  ${summary}`);
      }
    }).pipe(reportThreadErrors),
  ),
);

const askCommand = Command.make("ask", {
  ...projectLocationFlags,
  name: Argument.String("name").pipe(Argument.withDescription("Bot name or slug.")),
  message: Argument.String("message").pipe(Argument.withDescription("The job to give the bot.")),
  key: Flag.String("key").pipe(
    Flag.withDescription("Names this run. Defaults to a fresh key for every ask."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Give a bot a direct job on the running server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const slug = botSlug(flags.name);
      if (slug === undefined) {
        return yield* new ThreadUsageError({ detail: "The bot name needs a letter or digit." });
      }
      if (flags.message.trim() === "") {
        return yield* new ThreadUsageError({ detail: "The message cannot be blank." });
      }
      const now = yield* Clock.currentTimeMillis;
      yield* withThreadTools(
        flags,
        Effect.fn("cli.bot.ask")(function* (tools) {
          const started = yield* tools.call(
            "t3_workflow",
            {
              action: "start",
              workflow: `bot-${slug}`,
              input: { message: flags.message },
              idempotencyKey:
                Option.isSome(flags.key) && flags.key.value.trim() !== ""
                  ? flags.key.value
                  : `ask/${now}`,
            },
            WorkflowStartResult,
          );
          if (flags.json) return yield* printJson(started);
          yield* Console.log(`${started.run.runId}  ${started.run.status}  ${started.run.title}`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

export const botCommand = Command.make("bot").pipe(
  Command.withDescription("Create and ask Orca-style bots backed by durable workflows."),
  Command.withSubcommands([createCommand, listCommand, templatesCommand, askCommand]),
);
