import {
  type EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  type WorkflowRunReference,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { LayoutGridIcon, WorkflowIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn, randomUUID } from "../../lib/utils";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  RelativeLabel,
  WorkflowChip,
  WorkflowRunFeed,
  WorkflowStateWord,
  type WorkflowThreadTarget,
} from "./WorkflowRunFeed";
import { WorkflowReferenceMark } from "./WorkflowReferences";
import type { WorkflowPaneTab } from "./workflowPane.logic";
import {
  allWorkflowRunNodes,
  defaultWorkflowListTab,
  defaultWorkflowRunId,
  groupWorkflowRuns,
  listedWorkflowRuns,
  workflowQuestionKinds,
  workflowRunAskingKind,
  workflowRunAsksKind,
  workflowBotConversationInput,
  workflowBotConversationNodes,
  workflowBotLanes,
  workflowBotMessageText,
  workflowBotResponseText,
  workflowRunLists,
  workflowRunNow,
  workflowTriggerLine,
  type WorkflowListTab,
  type WorkflowRunNode,
  workflowRunInvolves,
  workflowReferenceLabel,
} from "@t3tools/client-runtime/workflows";

const WORKFLOWS_GUIDE_URL = "https://github.com/pingdotgg/t3code/blob/main/docs/user/workflows.md";
const EVERY_WORKFLOW = "";
// Never a kind: the questions of no kind are filtered by the empty kind.
const EVERY_KIND = "*";
const QUESTION_KIND_KEY = "t3code:workflows:question-kind";
const TABS: ReadonlyArray<{ readonly value: WorkflowListTab; readonly label: string }> = [
  {
    value: "needs-you",
    label: msg("Needs you", { $context: "tab: workflow runs that wait on the user" }),
  },
  { value: "running", label: msg("Running", { $context: "tab: workflow runs under way" }) },
  { value: "all", label: msg("All", { $context: "tab: every workflow run" }) },
];
const NOTHING: Record<WorkflowListTab, string> = {
  "needs-you": msg("Nothing waits on you."),
  running: msg("Nothing is running."),
  all: msg("No runs yet."),
};

export function WorkflowsEmpty({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

/** One environment's runs: the list to pick from, and the picked run told as a feed. */
export function WorkflowRunsView({
  environmentId,
  board: boardName,
  onBoardChange,
  selectedRunId,
  paneOpen,
  shownTab,
  onSelect,
  onOpenThread,
  onOpenReference,
  onOpenDefinitions,
}: {
  readonly environmentId: EnvironmentId;
  /** Open bot board: `all` or one bot workflow; null for the run list. */
  readonly board: string | null;
  readonly onBoardChange: (board: string | null, runId?: string | null) => void;
  readonly selectedRunId: string | null;
  /** Something is open beside the run, so the list makes room below `xl`. */
  readonly paneOpen: boolean;
  /** What shows beside the run, so what opened it can say so. */
  readonly shownTab: WorkflowPaneTab | null;
  readonly onSelect: (runId: string | null) => void;
  readonly onOpenThread: (runId: string, thread: WorkflowThreadTarget) => void;
  readonly onOpenReference: (runId: string, reference: WorkflowRunReference) => void;
  readonly onOpenDefinitions: () => void;
}) {
  const live = useEnvironmentQuery(serverEnvironment.workflowsLive({ environmentId, input: {} }));
  const [pickedTab, setPickedTab] = useState<WorkflowListTab | null>(null);
  const [workflow, setWorkflow] = useState(EVERY_WORKFLOW);
  const [pickedKind, setPickedKind] = useLocalStorage(QUESTION_KIND_KEY, EVERY_KIND, Schema.String);
  const gt = useGT();
  const m = useMessages();
  const [showSkipped, setShowSkipped] = useState(false);
  const nowMinute = useNowMinute();
  const snapshot = live.data;
  if (live.error) {
    return <WorkflowsEmpty title={gt("Could not load workflow runs")} description={live.error} />;
  }
  if (!snapshot) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        <T>Loading workflow runs…</T>
      </p>
    );
  }
  // A broken file is said even where nothing has run, or its workflows would just seem missing.
  const problemAlert =
    snapshot.definition?.problem == null ? null : (
      <div
        role="alert"
        className="flex shrink-0 items-center gap-3 border-b bg-destructive/4 px-4 py-2 text-xs"
      >
        <span className="min-w-0 flex-1 text-muted-foreground">
          <T>
            <span className="font-medium text-destructive-foreground">
              A workflow file has a problem.
            </span>{" "}
            The last version that did keeps running.
          </T>
        </span>
        <Button size="xs" variant="outline" onClick={onOpenDefinitions}>
          <T>Open the file</T>
        </Button>
      </div>
    );
  const withProblem = (empty: ReactNode) =>
    problemAlert === null ? (
      empty
    ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {problemAlert}
        {empty}
      </div>
    );
  const notHere = (
    <WorkflowsEmpty
      title={gt("This run is not here")}
      description={
        <T>
          This environment has no run with that link.{" "}
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
            onClick={() => onSelect(null)}
          >
            Back to the runs
          </button>
        </T>
      }
    />
  );
  // A link to a run says it is not here, even where nothing has run at all.
  if (snapshot.runs.length === 0 && snapshot.workflows.length === 0 && selectedRunId !== null) {
    return withProblem(notHere);
  }
  if (snapshot.runs.length === 0 && snapshot.workflows.length === 0) {
    return withProblem(
      <WorkflowsEmpty
        title={gt("No workflow runs yet")}
        description={
          <T>
            A workflow ties agents, code, schedules and questions to you into one run that survives
            restarts. Write one under{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={onOpenDefinitions}
            >
              Definitions
            </button>
            , or ask an agent to.{" "}
            <a
              href={WORKFLOWS_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Read the guide
            </a>
          </T>
        }
      />,
    );
  }
  // A skipped run opened by its link is shown all the same.
  const openedSkipped = snapshot.runs.some(
    (run) => run.runId === selectedRunId && run.status === "skipped",
  );
  const visible = listedWorkflowRuns(snapshot.runs, showSkipped || openedSkipped);
  const groups = groupWorkflowRuns(snapshot.workflows, visible.runs, snapshot.questions);
  const lists = workflowRunLists(groups);
  const all = allWorkflowRunNodes(groups);
  const section = groups.workflows.find((candidate) => candidate.name === workflow) ?? null;
  // A run that another invoked is not in the list itself; the one it is part of stands for it.
  const listedFor = (node: WorkflowRunNode | null): string | null => {
    if (node === null) return null;
    const parent = all.find((candidate) => candidate.run.runId === node.run.parentRunId);
    return parent === undefined ? node.run.runId : listedFor(parent);
  };
  // A run the address names is that run or none: another one's buttons would act on the wrong run.
  const selected =
    selectedRunId === null ? null : (all.find((node) => node.run.runId === selectedRunId) ?? null);
  // A run opened by its link is shown in a list that has it, so the list never points at nothing.
  const opening = defaultWorkflowListTab(groups);
  const holds = (candidate: WorkflowListTab) =>
    lists[candidate].some((node) => node.run.runId === listedFor(selected));
  const tab =
    pickedTab ??
    (selectedRunId === null || holds(opening) ? opening : holds("running") ? "running" : "all");
  const ofWorkflow = lists[tab].filter(
    (node) => section === null || workflowRunInvolves(node, section.name),
  );
  // The pick stays when its last question is answered: the rest must not appear in its place.
  const kind = tab === "needs-you" ? pickedKind : EVERY_KIND;
  const kinds =
    tab === "needs-you"
      ? workflowQuestionKinds(
          [{ workflows: snapshot.workflows, nodes: ofWorkflow }],
          kind === EVERY_KIND ? null : kind,
        )
      : [];
  const kindLabel = (candidate: (typeof kinds)[number]) =>
    candidate.label ?? gt("Other", { $context: "workflow questions that have no kind" });
  // The first run among these that itself asks a question listed under the kind.
  const askingKind = (nodes: ReadonlyArray<WorkflowRunNode>, asked: string) =>
    workflowRunAskingKind(snapshot.workflows, nodes, asked);
  const openRunId = listedFor(selected);
  // The run that is open stays listed whatever it asks, as one opened by its link may ask
  // another kind: the list never points at nothing.
  const listed =
    kind === EVERY_KIND
      ? ofWorkflow
      : ofWorkflow.filter(
          (node) =>
            workflowRunAsksKind(snapshot.workflows, node, kind) || node.run.runId === openRunId,
        );
  // With no run named, the one shown is one the list has: with a kind picked, one that asks it.
  const shown =
    selectedRunId !== null
      ? selected
      : kind === EVERY_KIND
        ? (all.find((node) => node.run.runId === defaultWorkflowRunId(groups)) ?? null)
        : askingKind(listed, kind);
  const pickKind = (next: string) => {
    setPickedKind(next);
    // Held here, so answering the kind's last question does not move the list on.
    setPickedTab("needs-you");
    if (selected === null || next === EVERY_KIND) return;
    // The open run would keep another kind's question and its answers beside the narrowed list,
    // so the address moves to a run that asks this kind, or to none.
    if (askingKind([selected], next)?.run.runId === selected.run.runId) return;
    onSelect(askingKind(ofWorkflow, next)?.run.runId ?? null);
  };
  const openListed = (runId: string | null) => {
    // Once its question is answered the run waits in no list, and the address alone would move
    // the list on to All: a run picked under a kind holds the list here, as picking the kind does.
    if (kind !== EVERY_KIND) setPickedTab("needs-you");
    // A run listed for a question a run it invoked asks opens on that run: its own questions are
    // of another kind, and would stand with their answers beside the narrowed list.
    const row = kind === EVERY_KIND ? undefined : listed.find((node) => node.run.runId === runId);
    onSelect((row === undefined ? null : askingKind([row], kind)?.run.runId) ?? runId);
  };
  const botLanes = workflowBotLanes(lists, Date.parse(`${nowMinute}:00.000Z`));
  const everyBotNeed = botLanes.needsYou;
  const everyBotWorking = botLanes.working;
  const everyBotDone = botLanes.done;
  const everyBotClosed = botLanes.closed;
  const botCount = new Set(
    [...everyBotNeed, ...everyBotWorking, ...everyBotDone, ...everyBotClosed].map(
      (node) => node.run.runId,
    ),
  ).size;
  const inBoard = (nodes: ReadonlyArray<WorkflowRunNode>) =>
    boardName === null || boardName === "all"
      ? nodes
      : nodes.filter((node) => node.run.workflow === boardName);
  const botNeeds = inBoard(everyBotNeed);
  const botWorking = inBoard(everyBotWorking);
  const botDone = inBoard(everyBotDone);
  const botClosed = inBoard(everyBotClosed);
  const openBoardRun = (runId: string) => onBoardChange(null, runId);
  const chatWorkflow = boardName !== null && boardName !== "all" ? boardName : null;
  const conversation = chatWorkflow === null ? [] : workflowBotConversationNodes(all, chatWorkflow);
  const botWorkflowNames = [
    ...new Set([
      ...snapshot.workflows
        .map((workflow) => workflow.name)
        .filter((name) => name.startsWith("bot-")),
      ...all
        .filter((node) => node.run.tags?.includes("bot") === true)
        .map((node) => node.run.workflow),
    ]),
  ].sort();
  const currentRunId = listedFor(shown);
  if (boardName !== null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {problemAlert}
        <BotKanbanBoard
          needsYou={botNeeds}
          working={botWorking}
          done={botDone}
          closed={botClosed}
          environmentId={environmentId}
          workflow={chatWorkflow}
          conversation={conversation}
          bots={botWorkflowNames}
          onOpen={openBoardRun}
          onOpenChat={(workflow) => onBoardChange(workflow)}
          onShowRuns={() => onBoardChange(null)}
        />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {problemAlert}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Below md there is room for one of the two: the list, or the run picked from it. */}
        <div
          className={cn(
            "min-h-0 w-full shrink-0 flex-col md:w-72 md:border-e",
            selectedRunId === null ? "flex" : "hidden",
            paneOpen ? "xl:flex" : "md:flex",
          )}
        >
          <div className="space-y-2 p-2 pb-1">
            <ToggleGroup
              aria-label={gt("Which runs")}
              className="w-full *:flex-1"
              value={[tab]}
              onValueChange={(next) => {
                const value = TABS.find((candidate) => candidate.value === next[0]);
                if (value !== undefined) setPickedTab(value.value);
              }}
            >
              {TABS.map(({ value, label }) => (
                <Toggle key={value} value={value}>
                  {m(label)}
                </Toggle>
              ))}
            </ToggleGroup>
            {botCount === 0 ? null : (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => onBoardChange("all")}
              >
                <LayoutGridIcon />
                <T>Bot board</T>
              </Button>
            )}
            {groups.workflows.length > 1 ? (
              <Select
                value={workflow}
                onValueChange={(value) => setWorkflow(value ?? EVERY_WORKFLOW)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={gt("Workflow", { $context: "picker that filters runs by workflow" })}
                >
                  <SelectValue>
                    {section === null
                      ? gt("All {count} workflows", { count: groups.workflows.length })
                      : section.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={EVERY_WORKFLOW}>
                    <T>All workflows</T>
                  </SelectItem>
                  {groups.workflows.map((candidate) => (
                    <SelectItem key={candidate.name} value={candidate.name}>
                      <span className="flex items-center gap-2">
                        <WorkflowChip name={candidate.name} />
                        {candidate.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {kinds.length === 0 ? null : (
              <Select value={kind} onValueChange={(value) => pickKind(value ?? EVERY_KIND)}>
                <SelectTrigger
                  size="sm"
                  aria-label={gt("Kind of question", {
                    $context: "picker that filters workflow runs by the kind of question they ask",
                  })}
                >
                  <SelectValue>
                    {kind === EVERY_KIND
                      ? gt("All kinds")
                      : kinds
                          .filter((candidate) => candidate.kind === kind)
                          .map((candidate) => `${kindLabel(candidate)} ${candidate.count}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={EVERY_KIND}>
                    <T>All kinds</T>
                  </SelectItem>
                  {kinds.map((candidate) => (
                    <SelectItem key={candidate.kind} value={candidate.kind}>
                      <span className="flex w-full items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{kindLabel(candidate)}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {candidate.count}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
            {kinds.length === 0 || kind !== EVERY_KIND ? null : (
              <p className="px-1 text-xs text-muted-foreground">
                {kinds.map((candidate) => `${kindLabel(candidate)} ${candidate.count}`).join(" · ")}
              </p>
            )}
            {section === null ? null : (
              <p className="px-1 text-xs text-muted-foreground">
                {workflowTriggerLine(section, m)}
              </p>
            )}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <nav aria-label={gt("Workflow runs")} className="p-2 pt-1">
              {listed.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {section?.neverRan
                    ? gt("Has not run yet.")
                    : kind === EVERY_KIND
                      ? m(NOTHING[tab])
                      : gt("No questions of this kind wait on you.")}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {listed.map((node) => (
                    <WorkflowRunListItem
                      key={node.run.runId}
                      node={node}
                      current={node.run.runId === currentRunId}
                      onSelect={openListed}
                    />
                  ))}
                </ul>
              )}
              {tab === "all" && visible.skipped > 0 && !openedSkipped ? (
                <div className="flex justify-center pt-2">
                  <Button size="xs" variant="ghost" onClick={() => setShowSkipped(!showSkipped)}>
                    {showSkipped
                      ? gt("Hide skipped")
                      : gt("Show {count} skipped", { count: visible.skipped })}
                  </Button>
                </div>
              ) : null}
            </nav>
          </ScrollArea>
        </div>
        <ScrollArea
          className={cn(
            "@container/feed min-h-0 min-w-0 flex-1",
            selectedRunId === null ? "hidden md:block" : "block",
          )}
        >
          {shown === null ? (
            selectedRunId === null ? null : (
              notHere
            )
          ) : (
            <WorkflowRunFeed
              key={shown.run.runId}
              environmentId={environmentId}
              node={shown}
              parent={all.find((node) => node.run.runId === shown.run.parentRunId)?.run ?? null}
              shownTab={shownTab}
              onSelect={onSelect}
              onOpenThread={(thread) => onOpenThread(shown.run.runId, thread)}
              onOpenReference={(reference) => onOpenReference(shown.run.runId, reference)}
            />
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

/** A run in the thread list's own shape: which workflow, its state in a word, and what it is at. */
function WorkflowRunListItem({
  node,
  current,
  onSelect,
}: {
  readonly node: WorkflowRunNode;
  readonly current: boolean;
  readonly onSelect: (runId: string | null) => void;
}) {
  const { run } = node;
  const m = useMessages();
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset",
          current ? "bg-accent" : "hover:bg-accent/50",
        )}
        onClick={() => onSelect(run.runId)}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <WorkflowChip name={run.workflow} />
          <span className="min-w-0 flex-1 truncate">{run.workflow}</span>
          <WorkflowStateWord node={node} />
        </span>
        <span className="truncate text-sm text-foreground">{run.title}</span>
        <span className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{workflowRunNow(node, m)}</span>
          <span className="shrink-0">
            <RelativeLabel value={run.updatedAt} />
          </span>
        </span>
      </button>
    </li>
  );
}

/** Bot runs as lanes: what needs a person, what is going, and what ended today or before. */
function BotKanbanBoard({
  environmentId,
  needsYou,
  working,
  done,
  closed,
  onOpen,
  onShowRuns,
  workflow,
  conversation,
  bots,
  onOpenChat,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflow: string | null;
  readonly conversation: ReadonlyArray<WorkflowRunNode>;
  readonly bots: ReadonlyArray<string>;
  readonly needsYou: ReadonlyArray<WorkflowRunNode>;
  readonly working: ReadonlyArray<WorkflowRunNode>;
  readonly done: ReadonlyArray<WorkflowRunNode>;
  readonly closed: ReadonlyArray<WorkflowRunNode>;
  readonly onOpen: (runId: string) => void;
  readonly onOpenChat: (workflow: string) => void;
  readonly onShowRuns: () => void;
}) {
  const gt = useGT();
  const lanes = [
    { id: "needs-you", title: gt("Needs you"), nodes: needsYou },
    { id: "working", title: gt("Working"), nodes: working },
    { id: "done", title: gt("Done"), nodes: done },
    { id: "closed", title: gt("Closed"), nodes: closed },
  ] as const;
  const count = needsYou.length + working.length + done.length + closed.length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            <T>Bot board</T>
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            <T>
              Open bot jobs across this server, grouped by what needs you next. Done and closed
              lanes hold today’s endings.
            </T>
          </p>
        </div>
        {workflow !== null || bots.length === 0 ? null : (
          <Select
            onValueChange={(value) => {
              if (typeof value === "string" && value !== "") onOpenChat(value);
            }}
          >
            <SelectTrigger size="sm" variant="ghost" aria-label={gt("Choose a bot to chat with")}>
              <SelectValue>
                <T>Chat</T>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {bots.map((bot) => (
                <SelectItem key={bot} value={bot}>
                  <span className="flex items-center gap-2">
                    <WorkflowChip name={bot} />
                    {bot.replace(/^bot-/, "")}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Button size="sm" variant="outline" onClick={onShowRuns}>
          <WorkflowIcon />
          <T>Runs</T>
        </Button>
      </div>
      {workflow === null ? null : (
        <BotConversation
          environmentId={environmentId}
          workflow={workflow}
          nodes={conversation}
          onOpen={onOpen}
        />
      )}
      {count === 0 ? (
        workflow === null ? (
          <WorkflowsEmpty
            title={gt("No bot jobs yet")}
            description={gt("Create a bot with `t3 bot create`, then ask it for a job.")}
          />
        ) : null
      ) : (
        <div className="grid min-h-0 flex-1 auto-cols-[minmax(15rem,19rem)] grid-flow-col overflow-x-auto">
          {lanes.map((lane) => (
            <section
              key={lane.id}
              aria-label={lane.title}
              className="flex min-h-0 flex-col border-e last:border-e-0"
            >
              <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                  {lane.title}
                </h3>
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
                  {lane.nodes.length}
                </span>
              </header>
              <ScrollArea className="min-h-0 flex-1">
                {lane.nodes.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    <T>Nothing here.</T>
                  </p>
                ) : (
                  <ul className="space-y-2 p-2">
                    {lane.nodes.map((node) => (
                      <BotBoardCard
                        key={node.run.runId}
                        environmentId={environmentId}
                        node={node}
                        onOpen={onOpen}
                      />
                    ))}
                  </ul>
                )}
              </ScrollArea>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const botModelStorageSchema = Schema.NullOr(ModelSelection);

const BOT_MODEL_SEPARATOR = "\u001f";
const BOT_DEFAULT_MODEL_VALUE = "bot-default";
const encodeBotModel = (selection: ModelSelection) =>
  `${selection.instanceId}${BOT_MODEL_SEPARATOR}${selection.model}`;
const decodeBotModel = (value: string): ModelSelection | null => {
  const index = value.indexOf(BOT_MODEL_SEPARATOR);
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + BOT_MODEL_SEPARATOR.length),
  };
};

const revealChatEnd = (element: HTMLElement | null) => {
  element?.scrollIntoView({ block: "end" });
};

/** A bot's direct-message jobs as a conversation; each sent message starts one durable run. */
function BotConversation({
  environmentId,
  workflow,
  nodes,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflow: string;
  readonly nodes: ReadonlyArray<WorkflowRunNode>;
  readonly onOpen: (runId: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const start = useAtomCommand(serverEnvironment.startWorkflowRun, { label: "bot chat send" });
  const [modelOverride, setModelOverride] = useLocalStorage(
    `t3code:bot-model:${environmentId}:${workflow}`,
    null,
    botModelStorageSchema,
  );
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const modelGroups = providers.flatMap((provider) => {
    const usable =
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.auth.status !== "unauthenticated" &&
      (provider.status === "ready" || provider.status === "warning" || provider.modelsRetained);
    return usable && provider.models.length > 0 ? [{ provider, models: provider.models }] : [];
  });
  const selectedModelLabel = modelGroups
    .flatMap(({ models }) => models)
    .find((model) => model.slug === modelOverride?.model)?.name;
  const botName = workflow.replace(/^bot-/, "");
  const send = async () => {
    const message = draft.trim();
    if (message === "" || sending) return;
    setSending(true);
    const result = await start({
      environmentId,
      input: {
        workflow,
        input: workflowBotConversationInput(nodes, message, modelOverride),
        idempotencyKey: `chat/${randomUUID()}`,
      },
    });
    setSending(false);
    if (result._tag === "Success") setDraft("");
  };
  return (
    <section
      aria-label={gt("Chat with {bot}", { bot: botName })}
      className="flex max-h-80 shrink-0 flex-col border-b"
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          {nodes.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {gt("Send a job or question. The bot answers as a durable workflow run.")}
            </p>
          ) : (
            nodes.map((node) => {
              const { run } = node;
              const response = workflowBotResponseText(run);
              return (
                <div key={run.runId} className="space-y-2">
                  <div className="ml-auto w-fit max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-primary-foreground">
                    <p className="whitespace-pre-wrap text-sm">{workflowBotMessageText(run)}</p>
                    <p className="pt-1 text-right text-2xs text-primary-foreground/70">
                      <RelativeLabel value={run.startedAt} />
                    </p>
                  </div>
                  <button
                    type="button"
                    className="block w-fit max-w-[85%] cursor-pointer rounded-2xl border bg-card px-3 py-2 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
                    onClick={() => onOpen(run.runId)}
                  >
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <WorkflowChip name={workflow} />
                      <WorkflowStateWord node={node} />
                    </span>
                    <span className="block whitespace-pre-wrap pt-1 text-sm text-foreground">
                      {response ?? workflowRunNow(node, m)}
                    </span>
                  </button>
                </div>
              );
            })
          )}
          {nodes.length === 0 ? null : (
            <div
              key={`${nodes.length}:${nodes.at(-1)?.run.runId}:${nodes.at(-1)?.run.updatedAt}`}
              ref={revealChatEnd}
            />
          )}
        </div>
      </ScrollArea>
      <form
        className="flex shrink-0 items-center gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Select
          modal={false}
          value={modelOverride ? encodeBotModel(modelOverride) : BOT_DEFAULT_MODEL_VALUE}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            setModelOverride(value === BOT_DEFAULT_MODEL_VALUE ? null : decodeBotModel(value));
          }}
        >
          <SelectTrigger
            size="sm"
            variant="ghost"
            className="w-36 shrink-0"
            aria-label={gt("Choose the bot model")}
          >
            <SelectValue>
              {modelOverride ? (selectedModelLabel ?? modelOverride.model) : gt("Bot default")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false} className="w-64">
            <SelectItem value={BOT_DEFAULT_MODEL_VALUE}>
              <T>Bot default</T>
            </SelectItem>
            {modelGroups.map(({ provider, models }) => (
              <SelectGroup key={provider.instanceId}>
                <SelectGroupLabel>{provider.displayName ?? provider.instanceId}</SelectGroupLabel>
                {models.map((model) => {
                  const selection = { instanceId: provider.instanceId, model: model.slug };
                  return (
                    <SelectItem key={model.slug} value={encodeBotModel(selection)}>
                      <span className="block truncate">
                        {model.name}
                        {model.isLegacy ? ` · ${gt("legacy")}` : ""}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            ))}
          </SelectPopup>
        </Select>
        <Input
          aria-label={gt("Message the bot")}
          value={draft}
          onValueChange={setDraft}
          placeholder={gt("Message {bot}", { bot: botName })}
        />
        <Button type="submit" size="sm" disabled={draft.trim() === "" || sending}>
          {sending ? gt("Sending…") : gt("Send", { $context: "verb, sends the message" })}
        </Button>
      </form>
    </section>
  );
}

function BotBoardCard({
  environmentId,
  node,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkflowRunNode;
  readonly onOpen: (runId: string) => void;
}) {
  const m = useMessages();
  const { run } = node;
  const detail = useEnvironmentQuery(
    serverEnvironment.workflowRun({ environmentId, input: { runId: run.runId } }),
  );
  const references = detail.data?.references ?? [];
  return (
    <li>
      <button
        type="button"
        className="flex w-full cursor-pointer flex-col gap-1 rounded-xl border bg-card px-3 py-2 text-left shadow-xs transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
        onClick={() => onOpen(run.runId)}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <WorkflowChip name={run.workflow} />
          <span className="min-w-0 flex-1 truncate">{run.workflow.replace(/^bot-/, "")}</span>
          <WorkflowStateWord node={node} />
        </span>
        <span className="line-clamp-2 text-sm font-medium text-foreground">{run.title}</span>
        <span className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{workflowRunNow(node, m)}</span>
          <span className="shrink-0">
            <RelativeLabel value={run.updatedAt} />
          </span>
        </span>
        {references.length === 0 ? null : (
          <span className="flex min-w-0 flex-wrap items-center gap-1 pt-0.5">
            {references.slice(0, 3).map((reference) => (
              <span
                key={`${reference.kind}:${reference.key}`}
                className="inline-flex min-w-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs text-muted-foreground"
              >
                <WorkflowReferenceMark reference={reference} />
                <span className="shrink-0">{workflowReferenceLabel(reference)}</span>
                {reference.state === null ? null : <span>{reference.state}</span>}
              </span>
            ))}
            {references.length <= 3 ? null : (
              <span className="text-2xs text-muted-foreground">+{references.length - 3}</span>
            )}
          </span>
        )}
      </button>
    </li>
  );
}
