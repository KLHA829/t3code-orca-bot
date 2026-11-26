import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorkflowRun, WorkflowRunsSnapshot } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { BotIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSidebar } from "../ui/sidebar";
import { useWorkflowEnvironmentIds } from "../workflows/useWorkflowEnvironmentIds";

const EXPANDED_KEY = "t3code:sidebar:bots:expanded";

interface SidebarBotEntry {
  readonly environmentId: EnvironmentId;
  readonly workflow: string;
  readonly label: string;
  readonly active: number;
  readonly needsYou: number;
}

const activeBotRun = (run: WorkflowRun) =>
  run.tags?.includes("bot") === true && run.endedAt === null;

function botEntries(
  environmentId: EnvironmentId,
  snapshot: WorkflowRunsSnapshot | undefined,
): ReadonlyArray<SidebarBotEntry> {
  if (snapshot === undefined) return [];
  const asking = new Set(snapshot.questions.map((question) => question.runId));
  return snapshot.workflows
    .filter((workflow) => workflow.name.startsWith("bot-"))
    .map((workflow) => {
      const runs = snapshot.runs.filter((run) => run.workflow === workflow.name);
      const active = runs.filter(activeBotRun);
      return {
        environmentId,
        workflow: workflow.name,
        label: workflow.name.replace(/^bot-/, ""),
        active: active.length,
        needsYou: active.filter((run) => run.status === "paused" || asking.has(run.runId)).length,
      };
    });
}

/** The sidebar's bot shelf. It subscribes to workflow runs only while expanded. */
export function SidebarBots() {
  const gt = useGT();
  const environmentIds = useWorkflowEnvironmentIds();
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  if (environmentIds.length === 0) return null;
  return (
    <section aria-label={gt("Bots")} className="mx-0.5 mb-1 shrink-0">
      <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {gt("Bots")}
      </CollapsibleSectionHeader>
      {expanded ? <SidebarBotList environmentIds={environmentIds} /> : null}
    </section>
  );
}

function SidebarBotList({
  environmentIds,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { environments } = useEnvironments();
  const live = useAtomValue(serverEnvironment.workflowsLiveAcross(JSON.stringify(environmentIds)));
  const loaded = live.map(({ environmentId, result }) => ({
    environmentId,
    snapshot: Option.getOrUndefined(AsyncResult.value(result)),
  }));
  const waiting = loaded.some(({ snapshot }) => snapshot === undefined);
  const bots = loaded.flatMap(({ environmentId, snapshot }) => botEntries(environmentId, snapshot));
  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  const openBoard = (bot: SidebarBotEntry | null) => {
    if (isMobile) setOpenMobile(false);
    const environmentId = bot?.environmentId ?? bots[0]?.environmentId ?? environmentIds[0];
    if (environmentId === undefined) return;
    void navigate({
      to: "/workflows",
      search: { env: environmentId, board: bot?.workflow ?? "all" },
    });
  };
  return (
    <div className="px-1 pb-1">
      {waiting && bots.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground">
          <T>Loading bots…</T>
        </p>
      ) : bots.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-sidebar-muted-foreground">
          <p>
            <T>No bots yet.</T>
          </p>
          {/* oxlint-disable-next-line t3code/no-untranslated-copy -- shell command stays English */}
          <p className="mt-0.5 font-mono text-2xs">t3 bot create</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-px" aria-label={gt("Bots")}>
          {bots.map((bot) => (
            <li key={`${bot.environmentId}:${bot.workflow}`}>
              <button
                type="button"
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                onClick={() => openBoard(bot)}
              >
                <BotIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{bot.label}</span>
                {environmentIds.length > 1 ? (
                  <span className="max-w-16 truncate text-2xs text-sidebar-muted-foreground">
                    {environmentLabel(bot.environmentId)}
                  </span>
                ) : null}
                {bot.needsYou > 0 ? (
                  <span
                    className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-2xs text-destructive-foreground tabular-nums"
                    aria-label={gt("{count} need you", { count: bot.needsYou })}
                  >
                    {bot.needsYou}
                  </span>
                ) : bot.active > 0 ? (
                  <span
                    className="rounded-full bg-sidebar-row-hover px-1.5 py-0.5 text-2xs text-sidebar-muted-foreground tabular-nums"
                    aria-label={gt("{count} active", { count: bot.active })}
                  >
                    {bot.active}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={cn(
          "mt-1 flex h-7 w-full cursor-pointer items-center rounded-md px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
        onClick={() => openBoard(null)}
      >
        <T>Open bot board</T>
      </button>
    </div>
  );
}
