import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  workflowBotConversationInput,
  workflowBotConversationNodes,
  workflowBotMessageText,
  workflowBotResponseText,
  workflowRunNow,
  workflowRunState,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import { EnvironmentId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportFailure } from "./WorkflowStepCard";
import { WORKFLOW_TONE_CLASS, WorkflowChip } from "./WorkflowsScreen";

export type BotChatParams = {
  readonly environmentId: string;
  readonly workflow: string;
};

const botText = (node: WorkflowRunNode, state: string, now: string, needsYou: boolean) => {
  const { run } = node;
  if (run.status === "completed") return workflowBotResponseText(run) ?? now;
  if (needsYou) return state;
  return workflowBotResponseText(run) ?? now;
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
        input: workflowBotConversationInput(turns, message),
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
                  {gt("Send a job or question. The bot answers as a durable workflow run.")}
                </Text>
              </View>
            ) : (
              turns.map((node) => {
                const state = workflowRunState(node, m);
                const needsYou = asking.has(node.run.runId);
                const response = botText(node, state.word, workflowRunNow(node, m), needsYou);
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
            className="flex-row items-end gap-2 border-t border-border-subtle px-4 pt-3"
            style={{ paddingBottom: insets.bottom + 12 }}
          >
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
        </>
      )}
    </KeyboardAvoidingView>
  );
}
