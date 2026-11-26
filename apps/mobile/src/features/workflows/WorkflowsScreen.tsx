import {
  defaultWorkflowListTab,
  groupWorkflowRuns,
  listedWorkflowRuns,
  workflowChip,
  workflowQuestionKinds,
  workflowRunAsksKind,
  workflowBotLanes,
  workflowRunLists,
  workflowRunNow,
  workflowRunState,
  type WorkflowListTab,
  type WorkflowRunNode,
  type WorkflowRunTone,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsSnapshot } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useNavigation } from "@react-navigation/native";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const TABS = [
  {
    value: "needs-you",
    label: msg("Needs you", { $context: "tab, workflow runs waiting on the user" }),
  },
  { value: "running", label: msg("Running", { $context: "tab, workflow runs under way" }) },
  { value: "bots", label: msg("Bots", { $context: "tab, bot workflow runs" }) },
  { value: "all", label: msg("All", { $context: "tab, all workflow runs" }) },
] as const satisfies ReadonlyArray<{
  readonly value: MobileWorkflowListTab;
  readonly label: string;
}>;

type MobileWorkflowListTab = WorkflowListTab | "bots";

const NOTHING: Record<WorkflowListTab, string> = {
  "needs-you": msg("Nothing waits on you."),
  running: msg("Nothing is running."),
  all: msg("No runs yet."),
};

export const WORKFLOW_TONE_CLASS: Record<WorkflowRunTone, string> = {
  input: "text-warning-foreground",
  failed: "text-danger-foreground",
  working: "text-primary",
  quiet: "text-foreground-muted",
  done: "text-foreground-muted",
};

// The same few colours every time for one workflow, so a list is read by its marks.
const CHIP_CLASS = [
  "bg-primary/15 text-primary",
  "bg-warning/20 text-warning-foreground",
  "bg-danger/15 text-danger-foreground",
  "bg-subtle-strong text-foreground-secondary",
  "bg-foreground/10 text-foreground",
] as const;

export function WorkflowChip(props: { readonly name: string }) {
  const chip = workflowChip(props.name);
  const [surface, text] = (CHIP_CLASS[chip.tone % CHIP_CLASS.length] ?? CHIP_CLASS[0]).split(" ");
  return (
    <View className={cn("h-5 w-6 items-center justify-center rounded-md", surface)}>
      <Text className={cn("font-t3-bold text-3xs", text)}>{chip.letters}</Text>
    </View>
  );
}

function RunRow(props: { readonly node: WorkflowRunNode; readonly onOpen: () => void }) {
  const { run } = props.node;
  const m = useMessages();
  const state = workflowRunState(props.node, m);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${run.title}, ${state.word}`}
      className="gap-1 border-b border-border-subtle px-5 py-3 active:bg-subtle"
      onPress={props.onOpen}
    >
      <View className="flex-row items-center gap-2">
        <WorkflowChip name={run.workflow} />
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {run.workflow}
        </Text>
        <Text className={cn("font-t3-medium text-xs", WORKFLOW_TONE_CLASS[state.tone])}>
          {state.word}
        </Text>
      </View>
      <Text className="font-t3-medium text-base text-foreground" numberOfLines={1}>
        {run.title}
      </Text>
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {workflowRunNow(props.node, m)}
        </Text>
        <Text className="text-xs text-foreground-muted">
          <RelativeTime timestamp={run.updatedAt} />
        </Text>
      </View>
    </Pressable>
  );
}

function EnvironmentBotRuns(props: {
  readonly label: ReactNode;
  readonly workflows: WorkflowRunsSnapshot["workflows"];
  readonly lists: Readonly<Record<WorkflowListTab, ReadonlyArray<WorkflowRunNode>>>;
  readonly openRun: (node: WorkflowRunNode) => () => void;
  readonly openChat: (workflow: string) => () => void;
  readonly bot: string | null;
  readonly onBotChange: (bot: string | null) => void;
}) {
  const gt = useGT();
  const nowMinuteMs = useNowMinuteMs();
  const botNames = props.workflows
    .map((workflow) => workflow.name)
    .filter((name) => name.startsWith("bot-"));
  const bot = props.bot !== null && botNames.includes(props.bot) ? props.bot : null;
  const unfiltered = workflowBotLanes(props.lists, nowMinuteMs);
  const inBot = (nodes: ReadonlyArray<WorkflowRunNode>) =>
    bot === null ? nodes : nodes.filter((node) => node.run.workflow === bot);
  const lanes = {
    needsYou: inBot(unfiltered.needsYou),
    working: inBot(unfiltered.working),
    done: inBot(unfiltered.done),
    closed: inBot(unfiltered.closed),
  };
  const sections = [
    { id: "needs-you", title: gt("Needs you"), nodes: lanes.needsYou },
    { id: "working", title: gt("Working"), nodes: lanes.working },
    { id: "done", title: gt("Done"), nodes: lanes.done },
    { id: "closed", title: gt("Closed"), nodes: lanes.closed },
  ].filter((lane) => lane.nodes.length > 0);
  return (
    <View>
      {props.label}
      {botNames.length === 0 ? null : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-5 pt-2"
        >
          <Chip
            label={gt("All bots")}
            selected={bot === null}
            size="large"
            onPress={() => props.onBotChange(null)}
          />
          {botNames.map((name) => (
            <Chip
              key={name}
              label={name.replace(/^bot-/, "")}
              selected={bot === name}
              size="large"
              onPress={() => props.onBotChange(name)}
            />
          ))}
        </ScrollView>
      )}
      {bot === null ? null : (
        <View className="px-5 pt-2">
          <Button
            label={gt("Chat with {bot}", { bot: bot.replace(/^bot-/, "") })}
            icon="text.bubble"
            fullWidth
            onPress={props.openChat(bot)}
          />
        </View>
      )}
      {sections.length === 0 ? (
        <View className="px-5 py-6">
          <Text className="text-center text-sm text-foreground-muted">
            {gt("No bot jobs yet.")}
          </Text>
          <Text className="pt-1 text-center text-xs text-foreground-muted">
            {bot === null
              ? gt("Create a bot with `t3 bot create`, then ask it for a job.")
              : gt("This bot has no jobs yet.")}
          </Text>
        </View>
      ) : (
        sections.map((lane) => (
          <View key={lane.id}>
            <View
              accessible
              accessibilityRole="header"
              className="flex-row items-center border-b border-border-subtle px-5 pb-1.5 pt-4"
            >
              <Text className="min-w-0 flex-1 font-t3-medium text-xs text-foreground-muted">
                {lane.title}
              </Text>
              <Text className="text-xs text-foreground-muted tabular-nums">
                {lane.nodes.length}
              </Text>
            </View>
            {lane.nodes.map((node) => (
              <RunRow key={node.run.runId} node={node} onOpen={props.openRun(node)} />
            ))}
          </View>
        ))
      )}
    </View>
  );
}

/** One environment's runs in the picked list. */
function EnvironmentRuns(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly snapshot: WorkflowRunsSnapshot;
  readonly tab: MobileWorkflowListTab;
  /** The kind of question to narrow Needs you to; null for every run in it. */
  readonly kind: string | null;
  readonly bot: string | null;
  readonly onBotChange: (bot: string | null) => void;
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const m = useMessages();
  const [showSkipped, setShowSkipped] = useState(false);
  const { snapshot, tab } = props;
  const visible = listedWorkflowRuns(snapshot.runs, showSkipped);
  const groups = groupWorkflowRuns(snapshot.workflows, visible.runs, snapshot.questions);
  const lists = workflowRunLists(groups);
  const openRun = (node: WorkflowRunNode) => () =>
    navigation.navigate("WorkflowRun", {
      environmentId: props.environmentId,
      runId: node.run.runId,
    });
  const label =
    props.label === null ? null : (
      <Text className="px-5 pb-1 pt-3 font-t3-medium text-xs text-foreground-muted">
        {props.label}
      </Text>
    );
  if (tab === "bots") {
    return (
      <EnvironmentBotRuns
        label={label}
        workflows={snapshot.workflows}
        lists={lists}
        openRun={openRun}
        openChat={(workflow) => () =>
          navigation.navigate("BotChat", { environmentId: props.environmentId, workflow })
        }
        bot={props.bot}
        onBotChange={props.onBotChange}
      />
    );
  }
  const inTab = lists[tab];
  const kind = tab === "needs-you" ? props.kind : null;
  const listed =
    kind === null
      ? inTab
      : inTab.filter((node) => workflowRunAsksKind(snapshot.workflows, node, kind));
  return (
    <View>
      {label}
      {listed.length === 0 ? (
        <Text className="px-5 py-6 text-center text-sm text-foreground-muted">
          {kind === null ? m(NOTHING[tab]) : gt("No questions of this kind wait on you.")}
        </Text>
      ) : (
        listed.map((node) => <RunRow key={node.run.runId} node={node} onOpen={openRun(node)} />)
      )}
      {tab === "all" && visible.skipped > 0 ? (
        <Pressable
          accessibilityRole="button"
          className="items-center px-5 py-4"
          onPress={() => setShowSkipped(!showSkipped)}
        >
          <Text className="text-xs text-foreground-muted">
            {showSkipped
              ? gt("Hide skipped")
              : gt("Show {count} skipped", { count: visible.skipped })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const TAB_ORDER: ReadonlyArray<WorkflowListTab> = ["needs-you", "running", "all"];

/** What waits on a person in each environment, as the kinds of question are counted from. */
const needsYouSources = (snapshots: ReadonlyArray<WorkflowRunsSnapshot>) =>
  snapshots.map((snapshot) => ({
    workflows: snapshot.workflows,
    nodes: workflowRunLists(
      groupWorkflowRuns(
        snapshot.workflows,
        listedWorkflowRuns(snapshot.runs, false).runs,
        snapshot.questions,
      ),
    )["needs-you"],
  }));

/** The Workflows tab: what waits on you first, in every environment this device is connected to. */
export function WorkflowsScreen() {
  const { environments, isReady } = useEnvironments();
  const [tab, setTab] = useState<MobileWorkflowListTab | null>(null);
  const [botFilters, setBotFilters] = useState<Readonly<Record<string, string | null>>>({});
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const m = useMessages();
  const live = useAtomValue(
    serverEnvironment.workflowsLiveAcross(
      JSON.stringify(environments.map((environment) => environment.environmentId)),
    ),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  if (isReady && environments.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title={gt("No environment connected")}
        detail={gt("Connect an environment to see its workflow runs.")}
      />
    );
  }
  const sections = environments.map((environment) => {
    const result = live.find((entry) => entry.environmentId === environment.environmentId)?.result;
    return {
      environment,
      snapshot: result === undefined ? null : Option.getOrNull(AsyncResult.value(result)),
      error: result?._tag === "Failure" ? formatEnvironmentQueryError(result.cause, m) : null,
    };
  });
  const withRuns = sections.flatMap(({ environment, snapshot }) =>
    snapshot !== null &&
    (snapshot.runs.length > 0 || snapshot.workflows.some(({ name }) => name.startsWith("bot-")))
      ? [{ environment, snapshot }]
      : [],
  );
  const settled = sections.every(({ snapshot, error }) => snapshot !== null || error !== null);
  // Open on the most pressing list any environment has.
  const opening =
    TAB_ORDER.find((candidate) =>
      withRuns.some(
        ({ snapshot }) =>
          defaultWorkflowListTab(
            groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions),
          ) === candidate,
      ),
    ) ?? "all";
  const shown = tab ?? opening;
  // The pick stays when its last question is answered: the rest must not appear in its place.
  const kind =
    shown === "needs-you" && AsyncResult.isSuccess(preferences)
      ? (preferences.value.workflowQuestionKind ?? null)
      : null;
  const kinds =
    shown === "needs-you"
      ? workflowQuestionKinds(needsYouSources(withRuns.map(({ snapshot }) => snapshot)), kind)
      : [];
  const pickKind = (next: string | undefined) => {
    // Held here, so answering the kind's last question does not move the list on.
    setTab("needs-you");
    void savePreferences({ workflowQuestionKind: next });
  };
  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
    >
      {sections.flatMap(({ environment, snapshot, error }) =>
        snapshot === null && error !== null
          ? [
              <Text
                key={`error:${environment.environmentId}`}
                className="px-5 py-3 text-sm text-danger-foreground"
              >
                {environments.length > 1 ? `${environment.label}: ${error}` : error}
              </Text>,
            ]
          : [],
      )}
      {withRuns.length === 0 ? (
        settled ? (
          <EmptyState
            variant="plain"
            title={gt("No workflow runs yet")}
            detail={gt(
              "A workflow ties agents, code, schedules and questions to you into one run that survives restarts. Write one on your computer, under Workflows, then Definitions.",
            )}
          />
        ) : null
      ) : (
        <>
          <View className="px-5 pb-2 pt-3">
            <SegmentedControl
              options={TABS.map((option) => ({ ...option, label: m(option.label) }))}
              selected={shown}
              onSelect={setTab}
              role="tab"
            />
          </View>
          {kinds.length === 0 ? null : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 px-5 pb-2"
            >
              <Chip
                label={gt("All kinds", { $context: "filter, every kind of workflow question" })}
                selected={kind === null}
                size="large"
                onPress={() => pickKind(undefined)}
              />
              {kinds.map((candidate) => (
                <Chip
                  key={candidate.kind}
                  label={`${
                    candidate.label ??
                    gt("Other", { $context: "workflow questions that have no kind" })
                  } ${candidate.count}`}
                  selected={kind === candidate.kind}
                  size="large"
                  onPress={() => pickKind(candidate.kind)}
                />
              ))}
            </ScrollView>
          )}
          {withRuns.map(({ environment, snapshot }) => (
            <EnvironmentRuns
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environments.length > 1 ? environment.label : null}
              snapshot={snapshot}
              tab={shown}
              kind={kind}
              bot={botFilters[environment.environmentId] ?? null}
              onBotChange={(bot) =>
                setBotFilters((current) => ({
                  ...current,
                  [environment.environmentId]: bot,
                }))
              }
            />
          ))}
        </>
      )}
    </ScreenScrollView>
  );
}
