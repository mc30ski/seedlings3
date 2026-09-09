"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { FiPlus, FiDownload, FiDatabase, FiShare2 } from "react-icons/fi";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";

type TaskDef = {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  colorPalette: string;
  bgColor: string;
  onClick: () => void;
  disabled?: boolean;
  disabledMessage?: string;
};

type Props = {
  tasks: TaskDef[];
  /** Blended-role scope. Only drives the explainer copy — the action list
   *  itself is built by the host and already differs per role. */
  scope?: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
  /** Worker type of the caller, for the trainee note. */
  workerType?: string | null;
};

export default function AdminTasksTab({ tasks, scope, workerType }: Props) {
  const isSuper = !!scope?.isSuper;
  const isAdminView = !!scope?.isAdmin || isSuper;
  return (
    <Box w="full" pb={8}>
      {/* Was a permanently-open yellow card saying the same thing for
          everyone. The action list differs sharply by role — two workday
          workflows for a worker, four setup/export ones for an admin — so
          the copy does too. */}
      <Box mb={3}>
        <TabExplainer
          storageKey={`seedlings:actionsTab:guideOpen:${isSuper ? "super" : isAdminView ? "admin" : "worker"}`}
          title="What Actions are"
        >
          {isAdminView ? (
            <>
              <ExplainerText>
                Guided, multi-step workflows — the things that would otherwise mean visiting
                four tabs in the right order. <Em>New Job Service</Em> walks a client,
                property, job and first visit through in one pass.
              </ExplainerText>
              <ExplainerText>
                The rest take data out rather than putting it in:{" "}
                <Em>Share Photos</Em> pulls job photos together to post or download, and the
                two exports give you a readable summary or the raw JSON of everything.
                Nothing here deletes or changes existing records.
              </ExplainerText>
            </>
          ) : (
            <>
              <ExplainerText>
                Guided, step-by-step workflows for the two moments that need one.{" "}
                <Em>Plan next work day</Em> walks tomorrow&rsquo;s claimed jobs, confirms them
                and offers to message the clients; <Em>Prepare for work day</Em> runs
                today&rsquo;s — review the schedule, confirm, and start your first stop.
              </ExplainerText>
              {workerType === "TRAINEE" ? (
                <ExplainerText>
                  As a trainee, planning is <Em>read-only</Em>: you get the summary of what is
                  coming, but confirming, releasing and messaging clients are your team
                  lead&rsquo;s to do.
                </ExplainerText>
              ) : (
                <ExplainerText>
                  Neither one does anything you cannot do card by card on the Jobs tab — they
                  just put the steps in order so nothing gets skipped on a busy morning.
                </ExplainerText>
              )}
            </>
          )}
        </TabExplainer>
      </Box>
      <VStack align="stretch" gap={3} pt={2}>
        {tasks.map((task) => (
          <Box
            key={task.id}
            as="button"
            onClick={task.onClick}
            p={5}
            rounded="xl"
            borderWidth="1px"
            borderColor={task.disabled ? "gray.200" : `${task.colorPalette}.200`}
            bg={task.disabled ? "gray.50" : task.bgColor}
            textAlign="left"
            cursor={task.disabled ? "default" : "pointer"}
            opacity={task.disabled ? 0.7 : 1}
            transition="all 0.15s"
            _hover={task.disabled ? {} : { shadow: "md", borderColor: `${task.colorPalette}.400` }}
            _active={task.disabled ? {} : { shadow: "sm" }}
            display="flex"
            alignItems="center"
            gap={4}
          >
            <Box
              p={3}
              rounded="lg"
              bg={task.disabled ? "gray.100" : `${task.colorPalette}.100`}
              color={task.disabled ? "gray.400" : `${task.colorPalette}.600`}
              display="flex"
              alignItems="center"
              justifyContent="center"
              flexShrink={0}
            >
              <task.icon size={24} />
            </Box>
            <Box flex="1">
              <Text fontWeight="semibold" fontSize="md" color={task.disabled ? "gray.500" : `${task.colorPalette}.800`}>
                {task.label}
              </Text>
              <Text fontSize="sm" color={task.disabled ? "gray.400" : `${task.colorPalette}.600`} mt={0.5}>
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
