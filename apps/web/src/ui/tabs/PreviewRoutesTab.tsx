"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { MapLink } from "@/src/ui/helpers/Link";

type RouteJob = {
  id: string;
  type: "claimable" | "claimed";
  property: string;
  address: string;
  city: string;
  price: number | null;
  estimatedMinutes: number | null;
  kind: string;
  startAt: string | null;
};

type RouteStop = {
  occurrenceId: string;
  order: number;
  property: string;
  address: string;
  reason: string;
};

type Suggestions = {
  route: RouteStop[];
  summary: string;
  estimatedEarnings: number;
  estimatedHours: number;
  additionalJobsToConsider?: string[];
};

type Response = {
  suggestions: Suggestions | null;
  raw?: string;
  message?: string;
  jobs: RouteJob[];
  targetUser?: { id: string; displayName: string | null };
};

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function PreviewRoutesTab() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadSuggestions() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<Response>("/api/preview/route-suggestions");
      setData(res);
    } catch (err: any) {
      setError(err?.message || "Failed to load suggestions");
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadSuggestions();
  }, []);

  const jobMap = new Map((data?.jobs ?? []).map((j) => [j.id, j]));

  return (
    <Box w="full" pb={8}>
      <HStack justify="space-between" mb={4}>
        <VStack align="start" gap={0}>
          <Text fontSize="lg" fontWeight="semibold">Route Suggestions</Text>
          <Text fontSize="xs" color="fg.muted">AI-powered route optimization for tomorrow's jobs</Text>
        </VStack>
        <Button size="sm" onClick={loadSuggestions} loading={loading}>
          Refresh
        </Button>
      </HStack>

      {loading && !data && (
        <Box textAlign="center" py={10}>
          <Spinner size="lg" />
          <Text fontSize="sm" color="fg.muted" mt={2}>Analyzing available jobs...</Text>
        </Box>
      )}

      {error && (
        <Text color="red.500" fontSize="sm" mb={4}>{error}</Text>
      )}

      {data?.message && !data.suggestions && (
        <Box p={4} bg="gray.50" rounded="md" mb={4}>
          <Text fontSize="sm" color="fg.muted">{data.message}</Text>
        </Box>
      )}

      {data?.suggestions && (
        <VStack align="stretch" gap={4}>
          {/* Summary */}
          <Box p={4} bg="blue.50" rounded="xl" borderWidth="1px" borderColor="blue.200">
            <Text fontSize="sm" fontWeight="medium" color="blue.700">{data.suggestions.summary}</Text>
            <HStack gap={4} mt={2}>
              {data.suggestions.estimatedEarnings > 0 && (
                <Text fontSize="xs" color="blue.600">
                  Est. earnings: ${data.suggestions.estimatedEarnings.toFixed(2)}
                </Text>
              )}
              {data.suggestions.estimatedHours > 0 && (
                <Text fontSize="xs" color="blue.600">
                  Est. time: {formatDuration(Math.round(data.suggestions.estimatedHours * 60))}
                </Text>
              )}
            </HStack>
          </Box>

          {/* Route */}
          <VStack align="stretch" gap={2}>
            {data.suggestions.route.map((stop, idx) => {
              const job = jobMap.get(stop.occurrenceId);
              const isClaimed = job?.type === "claimed";
              return (
                <Card.Root
                  key={stop.occurrenceId}
                  variant="outline"
                  borderColor={isClaimed ? "teal.200" : undefined}
                  bg={isClaimed ? "teal.50" : undefined}
                >
                  <Card.Body py="3" px="4">
                    <HStack gap={3} align="start">
                      <Box
                        w="28px"
                        h="28px"
                        borderRadius="full"
                        bg={isClaimed ? "teal.500" : "blue.500"}
                        color="white"
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        fontSize="xs"
                        fontWeight="bold"
                        flexShrink={0}
                        mt="1px"
                      >
                        {idx + 1}
                      </Box>
                      <VStack align="start" gap={1} flex="1" minW={0}>
                        <HStack gap={2} wrap="wrap">
                          <Text fontSize="sm" fontWeight="medium">{stop.property}</Text>
                          {isClaimed ? (
                            <Badge colorPalette="teal" variant="solid" fontSize="xs" borderRadius="full" px="2">Claimed</Badge>
                          ) : (
                            <Badge colorPalette="blue" variant="outline" fontSize="xs" borderRadius="full" px="2">Available</Badge>
                          )}
                          {job?.price != null && (
                            <Badge colorPalette="green" variant="solid" fontSize="xs" borderRadius="full" px="2">
                              ${job.price.toFixed(2)}
                            </Badge>
                          )}
                          {job?.estimatedMinutes != null && (
                            <Text fontSize="xs" color="fg.muted">~{formatDuration(job.estimatedMinutes)}</Text>
                          )}
                        </HStack>
                        <Box fontSize="xs">
                          <MapLink address={stop.address} />
                        </Box>
                        <Text fontSize="xs" color="fg.muted" fontStyle="italic">
                          {stop.reason}
                        </Text>
                      </VStack>
                    </HStack>
                  </Card.Body>
                </Card.Root>
              );
            })}
          </VStack>

          {/* Additional recommendations */}
          {data.suggestions.additionalJobsToConsider && data.suggestions.additionalJobsToConsider.length > 0 && (
            <Box mt={2}>
              <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2} textTransform="uppercase" letterSpacing="wide">
                Also Consider Claiming
              </Text>
              <VStack align="stretch" gap={1}>
                {data.suggestions.additionalJobsToConsider.map((id) => {
                  const job = jobMap.get(id);
                  if (!job) return null;
                  return (
                    <HStack key={id} fontSize="xs" px={2} py={1} bg="gray.50" rounded="md" gap={2}>
                      <Text fontWeight="medium">{job.property}</Text>
                      <Text color="fg.muted">{job.city}</Text>
                      {job.price != null && <Badge colorPalette="green" variant="solid" fontSize="xs" px="1.5" borderRadius="full">${job.price.toFixed(2)}</Badge>}
                    </HStack>
                  );
                })}
              </VStack>
            </Box>
          )}
        </VStack>
      )}

      {/* Raw fallback if JSON parsing failed */}
      {data?.raw && (
        <Box p={4} bg="gray.50" rounded="md" whiteSpace="pre-wrap" fontSize="sm">
          {data.raw}
        </Box>
      )}

      {/* All available jobs listing */}
      {data?.jobs && data.jobs.length > 0 && (
        <Box mt={6}>
          <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2} textTransform="uppercase" letterSpacing="wide">
            All Jobs for Tomorrow ({data.jobs.length})
          </Text>
          <VStack align="stretch" gap={1}>
            {data.jobs.map((job) => (
              <HStack key={job.id} fontSize="xs" px={2} py={1.5} borderWidth="1px" rounded="md" gap={2} justify="space-between">
                <HStack gap={2} flex="1" minW={0}>
                  <Badge
                    colorPalette={job.type === "claimed" ? "teal" : "gray"}
                    variant={job.type === "claimed" ? "solid" : "outline"}
                    fontSize="xs"
                    px="1.5"
                    borderRadius="full"
                  >
                    {job.type === "claimed" ? "Claimed" : "Open"}
                  </Badge>
                  <Text fontWeight="medium" truncate>{job.property}</Text>
                  <Text color="fg.muted" truncate>{job.city}</Text>
                </HStack>
                <HStack gap={2} flexShrink={0}>
                  {job.price != null && <Text color="green.600">${job.price.toFixed(2)}</Text>}
                  {job.estimatedMinutes != null && <Text color="fg.muted">~{formatDuration(job.estimatedMinutes)}</Text>}
                </HStack>
              </HStack>
            ))}
          </VStack>
        </Box>
      )}
    </Box>
  );
}
