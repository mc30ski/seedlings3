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
import { AlertTriangle, CheckCircle2, ExternalLink, Search } from "lucide-react";
import { apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { openEventSearch } from "@/src/lib/bus";

const AUDIT_CHECKS = [
  {
    id: "duplicate_clients",
    label: "Duplicate Client Names",
    description: "Finds clients with the same name that may be duplicates.",
  },
  {
    id: "duplicate_properties",
    label: "Duplicate Properties",
    description: "Finds properties with the same address that may be duplicates.",
  },
  {
    id: "duplicate_jobs",
    label: "Duplicate Service Jobs",
    description: "Finds multiple active jobs of the same type on the same property.",
  },
  {
    id: "duplicate_occurrences",
    label: "Duplicate Repeating Occurrences",
    description: "Finds SCHEDULED occurrences on the same job within 2 days of each other that may be accidental duplicates.",
  },
  {
    id: "missing_next_occurrence",
    label: "Missing Next Repeating Occurrence",
    description: "Finds repeating jobs completed in the last 2 months that don't have a next SCHEDULED occurrence — the auto-create may have failed.",
  },
] as const;

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

  const totalIssues = results?.reduce((sum, r) => sum + r.issues.length, 0) ?? 0;

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
                  <Text fontSize="sm" fontWeight="medium">{check.label}</Text>
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
          <HStack gap={2} mb={1}>
            <Text fontWeight="bold" fontSize="md">Results</Text>
            {totalIssues === 0 ? (
              <Badge colorPalette="green" variant="solid" fontSize="xs" px="2" borderRadius="full">
                <CheckCircle2 size={12} style={{ marginRight: 4 }} /> All Clear
              </Badge>
            ) : (
              <Badge colorPalette="red" variant="solid" fontSize="xs" px="2" borderRadius="full">
                <AlertTriangle size={12} style={{ marginRight: 4 }} /> {totalIssues} issue{totalIssues !== 1 ? "s" : ""} found
              </Badge>
            )}
          </HStack>
          {ranAt && (
            <Text fontSize="xs" color="fg.muted" mb={3}>
              Ran {new Date(ranAt).toLocaleString()} — these results may be stale if data has changed since then. Run again to refresh.
            </Text>
          )}

          <VStack align="stretch" gap={3}>
            {results.map((r) => (
              <Card.Root key={r.check} variant="outline" borderColor={r.issues.length > 0 ? "orange.300" : "green.300"}>
                <Card.Body p={4}>
                  <HStack justify="space-between" mb={r.issues.length > 0 ? 2 : 0}>
                    <Text fontWeight="semibold" fontSize="sm">{r.label}</Text>
                    {r.issues.length === 0 ? (
                      <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">No issues</Badge>
                    ) : (
                      <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                        {r.issues.length} issue{r.issues.length !== 1 ? "s" : ""}
                      </Badge>
                    )}
                  </HStack>
                  {r.issues.length > 0 && (
                    <VStack align="stretch" gap={1}>
                      {r.issues.map((issue, i) => (
                        <HStack key={i} gap={2} p={2} bg="orange.50" rounded="sm" fontSize="xs">
                          <AlertTriangle size={12} style={{ flexShrink: 0, color: "var(--chakra-colors-orange-500)" }} />
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
                                  // Trigger tab switch to admin > admin-jobs
                                  window.dispatchEvent(new CustomEvent("seedlings:switchTab", { detail: { outer: "admin", inner: "admin-jobs" } }));
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
            ))}
          </VStack>
        </Box>
      )}
    </Box>
  );
}
