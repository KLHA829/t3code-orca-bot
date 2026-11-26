import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  workflowBotChatStatusText,
  workflowBotConversationInput,
  workflowBotConversationNodes,
  workflowBotMessageText,
  workflowBotResponseText,
  workflowRunState,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import { EnvironmentId, type ModelSelection } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportFailure } from "./WorkflowStepCard";
import { WORKFLOW_TONE_CLASS, WorkflowChip } from "./WorkflowsScreen";

export type BotChatParams = {
  readonly environmentId: string;
  readonly workflow: string;
};

const botModelPreferenceKey = (environmentId: string, workflow: string) =>
  `${environmentId}:${workflow}`;

const botText = (
  node: WorkflowRunNode,
  resolve: Parameters<typeof workflowBotChatStatusText>[1],
) => {
  const { run } = node;
  if (run.status === "completed") {
    return workflowBotResponseText(run) ?? workflowBotChatStatusText(node, resolve);
  }
  return workflowBotChatStatusText(node, resolve);
};

function ChatBubble(props: {
  readonly children: ReactNode;
  readonly own?: boolean;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
}) {
  const body = (
    <View
      className={cn(
        "max-w-[86%] gap-1 rounded-3xl px-4 py-3",
        props.own ? "self-end bg-primary" : "self-start bg-card",
      )}
    >
      {props.children}
    </View>
  );
  return props.onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className="active:opacity-70"
    >
      {body}
    </Pressable>
  ) : (
    body
  );
}

/** A bot's direct-message runs as a conversation. Each sent message is one durable bot job. */
export function BotChatRouteScreen({ route }: StaticScreenProps<BotChatParams>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const workflow = route.params.workflow;
  const botName = workflow.replace(/^bot-/, "");
  const live = useEnvironmentQuery(serverEnvironment.workflowsLive({ environmentId, input: {} }));
  const snapshot = live.data;
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const start = useAtomCommand(serverEnvironment.startWorkflowRun, {
    label: "bot chat send",
    reportFailure: false,
  });
  const config = useEnvironmentServerConfig(environmentId);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const modelKey = botModelPreferenceKey(environmentId, workflow);
  const selectedModel = AsyncResult.isSuccess(preferences)
    ? (preferences.value.botModelSelections?.[modelKey] ?? null)
    : null;
  const modelOptions = useMemo(
    () => buildModelOptions(config, selectedModel, undefined, null),
    [config, selectedModel],
  );
  const selectedModelOption = modelOptions.find(
    (option) =>
      option.selection.instanceId === selectedModel?.instanceId &&
      option.selection.model === selectedModel.model,
  );
  const modelLabel = selectedModel
    ? (selectedModelOption?.label ?? selectedModel.model)
    : gt("Automatic");
  const groups =
    snapshot === null
      ? null
      : groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions);
  const asking = new Set((snapshot?.questions ?? []).map((question) => question.runId));
  const turns =
    groups === null ? [] : workflowBotConversationNodes(allWorkflowRunNodes(groups), workflow);
  const send = async () => {
    const message = draft.trim();
    if (message === "" || sending) return;
    setSending(true);
    const result = await start({
      environmentId,
      input: {
        workflow,
        input: workflowBotConversationInput(turns, message, selectedModel),
        idempotencyKey: `chat/${uuidv4()}`,
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setDraft("");
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
      return;
    }
    reportFailure(gt("Could not send the message"), result);
  };
  return (
    <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1 bg-screen">
      <AppBar title={botName} onBack={() => navigation.canGoBack() && navigation.goBack()} />
      {snapshot === null ? (
        <EmptyState
          variant="plain"
          title={
            live.error === null ? gt("Loading the conversation…") : gt("Could not load the bot")
          }
          detail={live.error ?? gt("One moment.")}
        />
      ) : (
        <>
          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              gap: 10,
              padding: 16,
              paddingBottom: 24,
            }}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          >
            {turns.length === 0 ? (
              <View className="items-center px-8 py-16">
                <Text className="text-center font-t3-medium text-base text-foreground">
                  {gt("Start the conversation")}
                </Text>
                <Text className="pt-1 text-center text-sm text-foreground-muted">
                  {gt(
                    "Type a request below. The bot remembers what it learns and keeps track of the work here.",
                  )}
                </Text>
              </View>
            ) : (
              turns.map((node) => {
                const state = workflowRunState(node, m);
                const needsYou = asking.has(node.run.runId);
                const response = botText(node, m);
                return (
                  <View key={node.run.runId} className="gap-2">
                    <ChatBubble own>
                      <Text className="text-base text-primary-foreground">
                        {workflowBotMessageText(node.run)}
                      </Text>
                      <Text className="text-xs text-primary-foreground/70">
                        <RelativeTime timestamp={node.run.startedAt} />
                      </Text>
                    </ChatBubble>
                    <ChatBubble
                      accessibilityLabel={gt("Open this bot run")}
                      onPress={() =>
                        navigation.navigate("WorkflowRun", {
                          environmentId,
                          runId: node.run.runId,
                        })
                      }
                    >
                      <View className="flex-row items-center gap-2">
                        <WorkflowChip name={workflow} />
                        <Text
                          className={cn("font-t3-medium text-xs", WORKFLOW_TONE_CLASS[state.tone])}
                        >
                          {state.word}
                        </Text>
                      </View>
                      <Text className="text-base text-foreground">{response}</Text>
                      {needsYou ? (
                        <Text className="text-xs text-warning-foreground">
                          {gt("Open the run to answer its question.")}
                        </Text>
                      ) : null}
                    </ChatBubble>
                  </View>
                );
              })
            )}
          </ScrollView>
          <View
            className="gap-2 border-t border-border-subtle px-4 pt-3"
            style={{ paddingBottom: insets.bottom + 12 }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Choose the bot model")}
              className="min-h-11 flex-row items-center gap-2 rounded-2xl bg-card px-4 active:bg-subtle"
              onPress={() =>
                navigation.navigate("BotChatModel", {
                  environmentId: route.params.environmentId,
                  workflow,
                })
              }
            >
              <Text className="text-sm text-foreground-muted">{gt("Model")}</Text>
              <Text
                className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {modelLabel}
              </Text>
              <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
            </Pressable>
            <View className="flex-row items-end gap-2">
              <TextInput
                accessibilityLabel={gt("Message the bot")}
                className="max-h-32 flex-1"
                multiline
                placeholder={gt("Message {bot}", { bot: botName })}
                value={draft}
                onChangeText={setDraft}
              />
              <Button
                label={gt("Send", { $context: "verb, sends the message" })}
                loading={sending}
                disabled={draft.trim() === ""}
                onPress={() => void send()}
              />
            </View>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

/** The bot chat model picker. Choices are kept on this device and sent with each chat message. */
export function BotChatModelPickerRouteScreen({ route }: StaticScreenProps<BotChatParams>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const workflow = route.params.workflow;
  const navigation = useNavigation();
  const gt = useGT();
  const config = useEnvironmentServerConfig(environmentId);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const key = botModelPreferenceKey(route.params.environmentId, workflow);
  const selectedModel = AsyncResult.isSuccess(preferences)
    ? (preferences.value.botModelSelections?.[key] ?? null)
    : null;
  const options = useMemo(
    () => buildModelOptions(config, selectedModel, undefined, null),
    [config, selectedModel],
  );
  const groups = useMemo(() => groupByProvider(options), [options]);
  const currentSelections = AsyncResult.isSuccess(preferences)
    ? (preferences.value.botModelSelections ?? {})
    : {};
  const choose = (selection: ModelSelection | null) => {
    const next = { ...currentSelections };
    if (selection === null) {
      delete next[key];
    } else {
      next[key] = selection;
    }
    void savePreferences({ botModelSelections: next });
    navigation.goBack();
  };
  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={gt("Chat model")}
        onBack={() => navigation.canGoBack() && navigation.goBack()}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ gap: 20, padding: 16, paddingBottom: 40 }}
      >
        <SelectionRow
          isFirst
          isLast
          selected={selectedModel === null}
          title={gt("Automatic")}
          subtitle={gt("Use the bot's configured model")}
          onPress={() => choose(null)}
        />
        {groups.map((group) => (
          <View key={group.providerKey} className="gap-2">
            <Text className="px-2 text-xs font-t3-medium uppercase tracking-wide text-foreground-muted">
              {group.providerLabel}
            </Text>
            <View>
              {group.models.map((option, index) => (
                <SelectionRow
                  key={option.key}
                  leading={
                    <ProviderIcon
                      iconUrl={option.providerIconUrl}
                      provider={option.providerDriver}
                      size={18}
                    />
                  }
                  isFirst={index === 0}
                  isLast={index === group.models.length - 1}
                  selected={
                    selectedModel?.instanceId === option.selection.instanceId &&
                    selectedModel.model === option.selection.model
                  }
                  disabled={option.isUnavailable}
                  title={option.label}
                  subtitle={[option.subtitle, option.isLegacy ? gt("Legacy") : null]
                    .filter(Boolean)
                    .join(" · ")}
                  onPress={() => choose(option.selection)}
                />
              ))}
            </View>
          </View>
        ))}
        {groups.length === 0 ? (
          <Text className="px-2 text-sm text-foreground-muted">
            {gt("No usable models are available on this environment.")}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
