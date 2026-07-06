"use client";

import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { AlertCircle, AlertTriangle, CheckCircle2, ExternalLink, Info, Search } from "lucide-react";
import { apiPost } from "@/src/lib/api";
import { fmtDateTime } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { openEventSearch } from "@/src/lib/bus";

type Severity = "issue" | "warning" | "info";

const AUDIT_CHECKS: ReadonlyArray<{ id: string; label: string; description: string; severity: Severity }> = [
  {
    id: "duplicate_clients",
    label: "Duplicate Client Names",
    description: "Finds clients with the same name that may be duplicates.",
    severity: "issue",
  },
  {
    id: "duplicate_properties",
    label: "Duplicate Properties",
    description: "Finds properties with the same address that may be duplicates.",
    severity: "issue",
  },
  {
    id: "duplicate_jobs",
    label: "Duplicate Service Jobs",
    description: "Finds multiple active jobs of the same type on the same property.",
    severity: "issue",
  },
  {
    id: "duplicate_occurrences",
    label: "Duplicate Repeating Occurrences",
    description: "Finds SCHEDULED occurrences on the same job within 2 days of each other that may be accidental duplicates.",
    severity: "issue",
  },
  {
    id: "missing_next_occurrence",
    label: "Missing Next Repeating Occurrence",
    description: "Finds repeating jobs completed in the last 2 months that don't have a next SCHEDULED occurrence — the auto-create may have failed.",
    severity: "warning",
  },
  {
    id: "time_estimate_mismatch",
    label: "Time Estimate Mismatch",
    description: "Repeating jobs whose median actual time is >25% off the estimate AND still have at least one recent occurrence with unapproved hours. Review the pending hours or update the estimate before approving.",
    severity: "warning",
  },
  {
    id: "stale_estimate",
    label: "Stale Estimate",
    description: "Repeating jobs where recent hours are ALL approved but the median run is still >25% off the estimate. The operator has blessed the actuals — consider updating the estimate to match reality.",
    severity: "info",
  },
  {
    id: "unclaimed_no_guidance",
    label: "Unclaimed Jobs Without Guidance",
    description: "Finds unclaimed SCHEDULED jobs that don't have any property photos with descriptions. Adding guidance helps workers know what to do when they pick up a job.",
    severity: "info",
  },
];

type AuditIssue = { id?: string; description: string; clientId?: string; jobId?: string; occurrenceId?: string };
type AuditResult = {
  check: string;
  label: string;
  issues: AuditIssue[];
};

// Module-level cache so results persist across tab switches
let cachedResults: AuditResult[] | null = null;
let cachedTimestamp: number | null = null;

export default function AuditTab() {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(AUDIT_CHECKS.map((c) => c.id))
  );
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<AuditResult[] | null>(cachedResults);
  const [ranAt, setRanAt] = useState<number | null>(cachedTimestamp);

  function toggleCheck(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(AUDIT_CHECKS.map((c) => c.id)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  async function runAudit() {
    if (selected.size === 0) return;
    setRunning(true);
    setResults(null);
    setRanAt(null);
    cachedResults = null;
    cachedTimestamp = null;
    try {
      const res = await apiPost<{ results: AuditResult[] }>("/api/admin/system-audit", {
        checks: [...selected],
      });
      const now = Date.now();
      setResults(res.results);
      setRanAt(now);
      cachedResults = res.results;
      cachedTimestamp = now;
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to run audit.", err) });
    } finally {
      setRunning(false);
    }
  }

  // Helpers to bucket by severity. Lookups against AUDIT_CHECKS — falls back to
  // "issue" if the server returns a check id we don't recognize (defensive).
  function severityFor(checkId: string): Severity {
    return AUDIT_CHECKS.find((c) => c.id === checkId)?.severity ?? "issue";
  }
  const issueResults = (results ?? []).filter((r) => severityFor(r.check) === "issue");
  const warningResults = (results ?? []).filter((r) => severityFor(r.check) === "warning");
  const infoResults = (results ?? []).filter((r) => severityFor(r.check) === "info");
  const issueCount = issueResults.reduce((s, r) => s + r.issues.length, 0);
  const warningCount = warningResults.reduce((s, r) => s + r.issues.length, 0);
  const infoCount = infoResults.reduce((s, r) => s + r.issues.length, 0);
  const totalIssues = issueCount + warningCount + infoCount;

  return (
    <Box>
      <Text fontWeight="bold" fontSize="lg" mb={1}>System Audit</Text>
      <Text fontSize="sm" color="fg.muted" mb={4}>
        Select which checks to run. The audit scans the system for potential data issues but does not take any action.
      </Text>

      {/* Check selection */}
      <Card.Root variant="outline" mb={4}>
        <Card.Body p={4}>
          <HStack justify="space-between" mb={3}>
            <Text fontWeight="semibold" fontSize="sm">Checks</Text>
            <HStack gap={2}>
              <Button size="xs" variant="ghost" onClick={selectAll}>All</Button>
              <Button size="xs" variant="ghost" onClick={selectNone}>None</Button>
            </HStack>
          </HStack>
          <VStack align="stretch" gap={2}>
            {AUDIT_CHECKS.map((check) => (
              <HStack
                key={check.id}
                gap={3}
                p={2}
                rounded="md"
                bg={selected.has(check.id) ? "blue.50" : undefined}
                cursor="pointer"
                onClick={() => toggleCheck(check.id)}
                _hover={{ bg: selected.has(check.id) ? "blue.100" : "gray.50" }}
              >
                <Checkbox.Root
                  checked={selected.has(check.id)}
                  onCheckedChange={() => toggleCheck(check.id)}
                  size="sm"
                  colorPalette="blue"
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                </Checkbox.Root>
                <Box flex="1">
                  <HStack gap={2} mb={0.5}>
                    <Text fontSize="sm" fontWeight="medium">{check.label}</Text>
                    <Badge
                      size="xs"
                      colorPalette={check.severity === "info" ? "blue" : check.severity === "warning" ? "yellow" : "orange"}
                      variant="subtle"
                    >
                      {check.severity === "info" ? "Info" : check.severity === "warning" ? "Warning" : "Issue"}
                    </Badge>
                  </HStack>
                  <Text fontSize="xs" color="fg.muted">{check.description}</Text>
                </Box>
              </HStack>
            ))}
          </VStack>
        </Card.Body>
      </Card.Root>

      {/* Run button */}
      <Button
        colorPalette="blue"
        size="md"
        onClick={() => void runAudit()}
        disabled={running || selected.size === 0}
        mb={4}
      >
        {running ? <Spinner size="sm" mr={2} /> : <Search size={16} style={{ marginRight: 8 }} />}
        {running ? "Running Audit..." : `Run Audit (${selected.size} check${selected.size !== 1 ? "s" : ""})`}
      </Button>

      {/* Results */}
      {results && (
        <Box>
          <HStack gap={2} mb={1} wrap="wrap">
            <Text fontWeight="bold" fontSize="md">Results</Text>
            {totalIssues === 0 ? (
              <Badge colorPalette="green" variant="solid" fontSize="xs" px="2" borderRadius="full">
                <CheckCircle2 size={12} style={{ marginRight: 4 }} /> All Clear
              </Badge>
            ) : (
              <>
                {issueCount > 0 && (
                  <Badge colorPalette="red" variant="solid" fontSize="xs" px="2" borderRadius="full">
                    <AlertTriangle size={12} style={{ marginRight: 4 }} /> {issueCount} issue{issueCount !== 1 ? "s" : ""}
                  </Badge>
                )}
                {warningCount > 0 && (
                  <Badge colorPalette="yellow" variant="solid" fontSize="xs" px="2" borderRadius="full">
                    <AlertCircle size={12} style={{ marginRight: 4 }} /> {warningCount} warning{warningCount !== 1 ? "s" : ""}
                  </Badge>
                )}
                {infoCount > 0 && (
                  <Badge colorPalette="blue" variant="solid" fontSize="xs" px="2" borderRadius="full">
                    <Info size={12} style={{ marginRight: 4 }} /> {infoCount} info
                  </Badge>
                )}
              </>
            )}
          </HStack>
          {ranAt && (
            <Text fontSize="xs" color="fg.muted" mb={3}>
              Ran {fmtDateTime(new Date(ranAt))} — these results may be stale if data has changed since then. Run again to refresh.
            </Text>
          )}

          {issueResults.length > 0 && (
            <Box mb={4}>
              <HStack gap={2} mb={2}>
                <AlertTriangle size={14} color="var(--chakra-colors-orange-500)" />
                <Text fontWeight="semibold" fontSize="sm" color="orange.700">Issues</Text>
                <Text fontSize="xs" color="fg.muted">— things that may need fixing</Text>
              </HStack>
              <VStack align="stretch" gap={3}>
                {issueResults.map((r) => renderResultCard(r))}
              </VStack>
            </Box>
          )}
          {warningResults.length > 0 && (
            <Box mb={4}>
              <HStack gap={2} mb={2}>
                <AlertCircle size={14} color="var(--chakra-colors-yellow-600)" />
                <Text fontWeight="semibold" fontSize="sm" color="yellow.700">Warnings</Text>
                <Text fontSize="xs" color="fg.muted">— heads-up items worth a look</Text>
              </HStack>
              <VStack align="stretch" gap={3}>
                {warningResults.map((r) => renderResultCard(r))}
              </VStack>
            </Box>
          )}
          {infoResults.length > 0 && (
            <Box>
              <HStack gap={2} mb={2}>
                <Info size={14} color="var(--chakra-colors-blue-500)" />
                <Text fontWeight="semibold" fontSize="sm" color="blue.700">Information</Text>
                <Text fontSize="xs" color="fg.muted">— FYI, not problems</Text>
              </HStack>
              <VStack align="stretch" gap={3}>
                {infoResults.map((r) => renderResultCard(r))}
              </VStack>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );

  function renderResultCard(r: AuditResult) {
    const severity = AUDIT_CHECKS.find((c) => c.id === r.check)?.severity ?? "issue";
    // Per-severity visual config — keeps the rest of the rendering palette-agnostic.
    const cfg = severity === "info"
      ? { palette: "blue", border: "blue.300", bg: "blue.50", iconColor: "var(--chakra-colors-blue-500)", Icon: Info, label: "Info", noun: "info" }
      : severity === "warning"
        ? { palette: "yellow", border: "yellow.300", bg: "yellow.50", iconColor: "var(--chakra-colors-yellow-600)", Icon: AlertCircle, label: "Warning", noun: "warning" }
        : { palette: "orange", border: "orange.300", bg: "orange.50", iconColor: "var(--chakra-colors-orange-500)", Icon: AlertTriangle, label: "Issue", noun: "issue" };
    const palette = r.issues.length === 0 ? "green" : cfg.palette;
    const borderColor = r.issues.length === 0 ? "green.300" : cfg.border;
    const issueBg = cfg.bg;
    const iconColor = cfg.iconColor;
    const IssueIcon = cfg.Icon;
    return (
              <Card.Root key={r.check} variant="outline" borderColor={borderColor}>
                <Card.Body p={4}>
                  <HStack justify="space-between" mb={r.issues.length > 0 ? 2 : 0}>
                    <HStack gap={2}>
                      <Text fontWeight="semibold" fontSize="sm">{r.label}</Text>
                      <Badge size="xs" colorPalette={cfg.palette} variant="subtle">
                        {cfg.label}
                      </Badge>
                    </HStack>
                    {r.issues.length === 0 ? (
                      <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                        None
                      </Badge>
                    ) : (
                      <Badge colorPalette={palette} variant="subtle" fontSize="xs" px="2" borderRadius="full">
                        {r.issues.length} {cfg.noun}{cfg.noun === "info" ? "" : (r.issues.length !== 1 ? "s" : "")}
                      </Badge>
                    )}
                  </HStack>
                  {r.issues.length > 0 && (
                    <VStack align="stretch" gap={1}>
                      {r.issues.map((issue, i) => (
                        <HStack key={i} gap={2} p={2} bg={issueBg} rounded="sm" fontSize="xs">
                          <IssueIcon size={12} style={{ flexShrink: 0, color: iconColor }} />
                          <Text flex="1">{issue.description}</Text>
                          <HStack gap={1} flexShrink={0}>
                            {issue.clientId && (
                              <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="blue"
                                px="1"
                                onClick={() => openEventSearch("jobsTabToClientsTabSearch", "", true, issue.clientId)}
                                title="View Client"
                              >
                                Client <ExternalLink size={10} style={{ marginLeft: 2 }} />
                              </Button>
                            )}
                            {issue.jobId && (
                              <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="blue"
                                px="1"
                                onClick={() => openEventSearch("jobsTabToServicesTabSearch", "", true, `${issue.jobId}:${issue.occurrenceId ?? ""}`)}
                                title="View Job Service"
                              >
                                Service <ExternalLink size={10} style={{ marginLeft: 2 }} />
                              </Button>
                            )}
                            {issue.occurrenceId && (
                              <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="blue"
                                px="1"
                                onClick={() => {
                                  // Navigate to Admin Jobs → specific occurrence
                                  window.sessionStorage.setItem("servicesTabToJobsNav", `${issue.occurrenceId}|`);
                                  // Trigger tab switch to admin > jobs
                                  window.dispatchEvent(new CustomEvent("seedlings:switchTab", { detail: { outer: "admin", inner: "jobs" } }));
                                }}
                                title="View Occurrence in Jobs"
                              >
                                Occurrence <ExternalLink size={10} style={{ marginLeft: 2 }} />
                              </Button>
                            )}
                          </HStack>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                </Card.Body>
              </Card.Root>
    );
  }
}
