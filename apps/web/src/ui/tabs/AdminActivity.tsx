import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Heading,
  HStack,
  Button,
  Stack,
  Badge,
  Text,
  Accordion,
} from "@chakra-ui/react";
import { apiGet } from "../../lib/api";
import { equipmentStatusColor, prettyStatus, prettyDate } from "../../lib/lib";
import { openAdminEquipmentSearchOnce } from "@/src/lib/bus";
import { getErrorMessage } from "../../lib/errors";
import SearchWithClear from "../components/SearchWithClear";
import LoadingCenter from "../helpers/LoadingCenter";
import InlineMessage, { InlineMessageType } from "../helpers/InlineMessage";

type ActivityEvent = {
  id: string;
  at: string; // ISO
  type: string;
  details?: Record<string, any>;
};

type ActivityUser = {
  userId: string;
  displayName: string | null;
  email: string | null;
  lastActivityAt: string | null; // ISO
  count: number;
  events: ActivityEvent[];
};

function DetailsBlock({ details }: { details?: Record<string, any> | null }) {
  if (
    !details ||
    (typeof details === "object" && Object.keys(details).length === 0)
  ) {
    return null;
  }

  return (
    <Box mt="8px">
      {details.role && <Heading size="md">{details.role}</Heading>}
      {details.email && <Heading size="sm">{details.email}</Heading>}

      {(details.equipmentName || details.qrSlug) && (
        <Box>
          {details.equipmentName && (
            <Heading size="md">{details.equipmentName}</Heading>
          )}
          <Heading size="sm">
            {details.brand ? `${details.brand} ` : ""}
            {details.model ? `${details.model} ` : ""}
          </Heading>
          {details.qrSlug && (
            <Text fontSize="sm" color="gray.500" mt={1}>
              <Text as="span" fontWeight="bold">
                ID:{" "}
              </Text>
              <Text
                as="button"
                onClick={() => openAdminEquipmentSearchOnce(details.qrSlug)}
                color="blue.600"
                textDecoration="underline"
                _hover={{ color: "blue.700" }}
                p={0}
              >
                {details.qrSlug}
              </Text>
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

export default function AdminActivity() {
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ActivityUser[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);

  const [inlineMsg, setInlineMsg] = useState<{
    msg: string;
    type: InlineMessageType;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<ActivityUser[]>(`/api/admin/activity`);
      setRows(data);
      setExpanded([]);
    } catch (err) {
      setInlineMsg({
        msg: "Failed to load activity: " + getErrorMessage(err),
        type: InlineMessageType.ERROR,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasRows = rows.length > 0;

  const totalEvents = useMemo(
    () => rows.reduce((acc, r) => acc + (r.events?.length || 0), 0),
    [rows]
  );

  const sortedRows = useMemo(() => {
    const toTs = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
    let filtered = [...rows].sort((a, b) => {
      const tb = toTs(b.lastActivityAt);
      const ta = toTs(a.lastActivityAt);
      return tb - ta;
    });

    const ql = q.trim().toLowerCase();
    if (!ql) return filtered;

    filtered = filtered.filter((row) => {
      const displayName = row.displayName ? row.displayName.toLowerCase() : "";
      const email = row.email ? row.email.toLowerCase() : "";

      return displayName.includes(ql) || email.includes(ql);
    });

    return filtered;
  }, [rows, q]);

  const expandAll = () => setExpanded(sortedRows.map((u) => u.userId));
  const collapseAll = () => setExpanded([]);

  return (
    <Box>
      <Heading size="md" mb="3">
        Activity by User (for last 30 days)
      </Heading>

      {inlineMsg && <InlineMessage type={inlineMsg.type} msg={inlineMsg.msg} />}

      {/* Controls */}
      <HStack wrap="wrap" gap="6px" mb="3">
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="user-search"
          placeholder="Search users…"
        />
        <HStack ml="auto" gap="6px">
          <Button
            size="sm"
            variant="outline"
            onClick={expandAll}
            disabled={!hasRows}
          >
            Expand all
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={collapseAll}
            disabled={!hasRows}
          >
            Collapse all
          </Button>
        </HStack>
      </HStack>

      <HStack fontSize="sm" color="gray.600" mb="2">
        <Text>
          {rows.length} user{rows.length !== 1 ? "s" : ""}
        </Text>
        <Text>·</Text>
        <Text>
          {totalEvents} event{totalEvents !== 1 ? "s" : ""}
        </Text>
      </HStack>

      {loading && <LoadingCenter />}
      {!loading && rows.length === 0 && (
        <Text color="gray.600">No matching activity.</Text>
      )}

      {!loading && sortedRows.length > 0 && (
        <Accordion.Root
          multiple
          value={expanded}
          onValueChange={(details: { value: string[] }) =>
            setExpanded(details?.value ?? [])
          }
        >
          {sortedRows.map((u) => {
            const displayName = u.displayName || u.email;
            return (
              <Accordion.Item
                key={u.userId}
                value={u.userId}
                style={{
                  borderRadius: "12px",
                  overflow: "hidden",
                  border: "1px solid var(--chakra-colors-gray-200)",
                  marginBottom: "8px",
                  background: "var(--chakra-colors-white)",
                }}
              >
                <Accordion.ItemTrigger
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    display: "block",
                    background: "var(--chakra-colors-white)",
                  }}
                >
                  <HStack
                    justify="space-between"
                    w="100%"
                    align="center"
                    wrap="wrap"
                    gap="6px"
                  >
                    <HStack gap="8px" minW="0">
                      <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        overflow="hidden"
                        textOverflow="ellipsis"
                      >
                        {displayName || "(no name)"}
                      </Text>
                      {displayName !== u.email && <Badge>{u.email}</Badge>}
                    </HStack>
                    <HStack gap="8px">
                      <Badge colorPalette="gray">
                        {u.count} event{u.count !== 1 ? "s" : ""}
                      </Badge>
                      <Badge>Last: {prettyDate(u.lastActivityAt)}</Badge>
                      <Accordion.ItemIndicator />
                    </HStack>
                  </HStack>
                </Accordion.ItemTrigger>

                <Accordion.ItemContent>
                  <Stack p="12px" gap="8px">
                    {u.events.length === 0 && (
                      <Text color="gray.600" fontSize="sm">
                        No activity found for this user (within current limits).
                      </Text>
                    )}
                    {u.events.map((e) => (
                      <Box
                        key={e.id}
                        p="12px"
                        borderWidth="1px"
                        borderRadius="8px"
                        bg="white"
                      >
                        <HStack
                          justify="space-between"
                          align="start"
                          wrap="wrap"
                          gap="6px"
                        >
                          <Badge
                            fontSize="xs"
                            colorPalette={equipmentStatusColor(e.type)}
                          >
                            {prettyStatus(e.type)}
                          </Badge>

                          <Text fontSize="xs" color="gray.600">
                            {prettyDate(e.at)}
                          </Text>
                        </HStack>

                        <DetailsBlock details={e.details} />
                      </Box>
                    ))}
                  </Stack>
                </Accordion.ItemContent>
              </Accordion.Item>
            );
          })}
        </Accordion.Root>
      )}
    </Box>
  );
}
