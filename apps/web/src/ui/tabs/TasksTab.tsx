"use client";
import type { WorkerType } from "@repo/money";

import { Box, Text, VStack } from "@chakra-ui/react";
import { FiPlus, FiDownload, FiDatabase, FiShare2 } from "react-icons/fi";
import TabExplainer, { Em, ExplainerText, CapabilitySection } from "@/src/ui/components/TabExplainer";
import type { Scope } from "@/src/lib/scope";
import type { Entitlement } from "@repo/permissions";

type TaskDef = {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  colorPalette: string;
  bgColor: string;
  onClick: () => void;
  /**
   * Entitlements this shortcut's OWN endpoints are guarded on — every one
   * must be held or the card is not rendered.
   *
   * There used to be two hardcoded lists here, `workerTasks` and
   * `staffTasks`, and which you got was decided by which shell mounted the
   * tab. That is the deleted role model in another shape, and it broke the
   * moment the shells merged: `workerTasks` stopped being mounted at all,
   * so the two workday workflows vanished for everybody, while the setup
   * and export cards — gated by nothing — appeared for every holder of
   * `schedule.view`. A worker was offered Export Summary and got "Export
   * failed" from the 403.
   *
   * Omitted means the tab's own TAB_REQUIREMENTS row is the whole gate,
   * which is the honest answer for the workday workflows: every route they
   * touch is OWNERSHIP, scoped to the caller.
   */
  requires?: readonly Entitlement[];
  disabled?: boolean;
  disabledMessage?: string;
};

type Props = {
  tasks: TaskDef[];
  /** One-tab scope. Only drives the explainer copy — the action list
   *  itself is built by the host and already differs per role. */
  scope?: Scope;
  /** Worker type of the caller, for the pay-class note. */
  workerType?: WorkerType | null;
  fieldCleared?: boolean;
};

export default function TasksTab({ tasks, scope, workerType, fieldCleared }: Props) {
  // The explainer's own gating comes from CapabilitySection now.
  const canManageSchedule = !!scope?.can("schedule.manage");
  // FAILS CLOSED. No scope means no way to answer "may they", and the
  // answer a missing prop should produce is "no", not "show everything".
  const visibleTasks = tasks.filter(
    (t) => !t.requires?.length || t.requires.every((e) => !!scope?.can(e)),
  );
  return (
    <Box w="full" pb={8}>
      {/* Was a permanently-open yellow card saying the same thing for
          everyone. The action list differs sharply by role — two workday
          workflows for a worker, four setup/export ones for someone with schedule authority — so
          the copy does too. */}
        <TabExplainer
          explainerId="seedlings:actionsTab:guideOpen"
        >
          <ExplainerText>
            Guided, step-by-step workflows — the things that would otherwise mean visiting
            several tabs in the right order. Nothing here does anything you cannot do card by
            card elsewhere; they just put the steps in order so nothing gets skipped on a busy
            morning, and nothing here deletes or changes existing records.
          </ExplainerText>
          <ExplainerText>
            <Em>Plan next work day</Em> walks tomorrow&rsquo;s claimed jobs, confirms them and
            offers to message the clients; <Em>Prepare for work day</Em> runs today&rsquo;s —
            review the schedule, confirm, and start your first stop.
          </ExplainerText>
          {fieldCleared === false && !canManageSchedule && (
            <ExplainerText>
              Without field clearance, planning is <Em>read-only</Em>: you get the summary of what is
              coming, but confirming, releasing and messaging clients are your team
              lead&rsquo;s to do.
            </ExplainerText>
          )}
          {/* ONE SECTION PER CAPABILITY, matching the `requires` on the
              cards themselves. These three sat together under
              `schedule.manage`, which stopped being true once each card
              was gated on its own endpoint: Share Photos needs only
              `schedule.contribute` and the exports need `books.view`, so
              a worker saw the card with no explanation and a bookkeeper
              read about a wizard they do not have. */}
          {canManageSchedule && (
            <CapabilitySection capability="schedule.manage" scope={scope}>
              <ExplainerText>
                <Em>New Job Service</Em> walks a client, property, job and first visit through
                in one pass.
              </ExplainerText>
            </CapabilitySection>
          )}
          <CapabilitySection capability="schedule.contribute" scope={scope}>
            <ExplainerText>
              <Em>Share Photos</Em> pulls job photos together to post or download. It reads
              and saves; it does not publish anything on your behalf.
            </ExplainerText>
          </CapabilitySection>
          <CapabilitySection capability="books.view" scope={scope}>
            <ExplainerText>
              The two exports take data out rather than putting it in — a readable summary,
              or the raw JSON of everything.
            </ExplainerText>
          </CapabilitySection>
        </TabExplainer>
      <VStack align="stretch" gap={3} pt={2}>
        {visibleTasks.map((task) => (
          <Box
            key={task.id}
            as="button"
            onClick={task.onClick}
            p={5}
            rounded="xl"
            borderWidth="1px"
            borderColor={task.disabled ? "gray.emphasized" : `${task.colorPalette}.emphasized`}
            bg={task.disabled ? "gray.faint" : task.bgColor}
            textAlign="left"
            cursor={task.disabled ? "default" : "pointer"}
            opacity={task.disabled ? 0.7 : 1}
            transition="all 0.15s"
            _hover={task.disabled ? {} : { shadow: "md", borderColor: `${task.colorPalette}.strong` }}
            _active={task.disabled ? {} : { shadow: "sm" }}
            display="flex"
            alignItems="center"
            gap={4}
          >
            <Box
              p={3}
              rounded="lg"
              bg={task.disabled ? "gray.subtle" : `${task.colorPalette}.subtle`}
              color={task.disabled ? "gray.400" : `${task.colorPalette}.fg`}
              display="flex"
              alignItems="center"
              justifyContent="center"
              flexShrink={0}
            >
              <task.icon size={24} />
            </Box>
            <Box flex="1">
              <Text fontWeight="semibold" fontSize="md" color={task.disabled ? "gray.fg" : `${task.colorPalette}.fg`}>
                {task.label}
              </Text>
              <Text fontSize="sm" color={task.disabled ? "gray.400" : `${task.colorPalette}.fg`} mt={0.5}>
                {task.disabled && task.disabledMessage ? task.disabledMessage : task.description}
              </Text>
            </Box>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

export { type TaskDef };
export { FiPlus, FiDownload, FiDatabase, FiShare2 };
