"use client";

// ─────────────────────────────────────────────────────────────────────────────
// SUPER -> SYSTEM -> DISPLAYS
//
// Pair a wall screen, see whether it is alive, change what it shows, kill it.
//
// Super-only throughout. Pairing a device that then reads live job and worker
// data with NO user session is a security-boundary action, the same tier as
// approving a user or publishing a policy.
//
// PHONE-FIRST ON PURPOSE. This is the rare tab you almost always use standing
// in a shop with a phone in one hand and a code counting down on the wall, so
// the code field takes a numeric keypad and the approve flow is three taps.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Image,
  Input,
  Portal,
  Select,
  Spinner,
  Switch,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { Eye, EyeOff, Monitor, RefreshCw, Trash2 } from "lucide-react";
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import { fmtTimeOpts } from "@/src/lib/dates";

type Liveness = "live" | "stale" | "offline" | "never";

type DisplayRow = {
  id: string;
  name: string;
  mode: "PUBLIC" | "PRIVATE";
  farViewing: boolean;
  pairedAt: string;
  pairedBy: string | null;
  lastSeenAt: string | null;
  lastSeenIp: string | null;
  liveness: Liveness;
  quietDays: number;
};

type PendingRow = {
  id: string;
  code: string;
  requestedIp: string | null;
  requestedUserAgent: string | null;
  expiresAt: string;
};

const LIVENESS: Record<Liveness, { label: string; palette: string }> = {
  live: { label: "Live", palette: "green" },
  stale: { label: "Stale", palette: "yellow" },
  offline: { label: "Offline", palette: "red" },
  never: { label: "Never connected", palette: "gray" },
};

const MODE_COLLECTION = createListCollection({
  items: [
    { label: "Public — waiting room", value: "PUBLIC" },
    { label: "Private — back office", value: "PRIVATE" },
  ],
});

export default function DisplaysTab() {
  const [loading, setLoading] = useState(true);
  const [displays, setDisplays] = useState<DisplayRow[]>([]);
  const [pending, setPending] = useState<PendingRow[]>([]);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"PUBLIC" | "PRIVATE">("PUBLIC");
  const [farViewing, setFarViewing] = useState(true);
  const [approving, setApproving] = useState(false);
  // The refresh control DID refetch, silently and in ~80ms, so it looked
  // broken — you press it and nothing anywhere on screen changes. Feedback is
  // the whole job of that button; the fetch was never the problem.
  const [refreshing, setRefreshing] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  // The re-pair dialog. When set, approving REPLACES this screen instead of
  // adding another. See the approve route: a device that loses its browser
  // storage comes back looking brand new, and without this the old row
  // lingers as a credential nobody holds.
  const [rePairing, setRePairing] = useState<DisplayRow | null>(null);
  const [rePairCode, setRePairCode] = useState("");
  const [rePairBusy, setRePairBusy] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<DisplayRow | null>(null);

  const load = useCallback(async (opts: { manual?: boolean } = {}) => {
    if (opts.manual) setRefreshing(true);
    const startedAt = Date.now();
    try {
      const d = await apiGet<{ displays: DisplayRow[]; pending: PendingRow[] }>("/api/super/displays");
      setDisplays(d.displays ?? []);
      setPending(d.pending ?? []);
      setLoadedAt(Date.now());
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load displays", err) });
    } finally {
      setLoading(false);
      if (opts.manual) {
        // Hold the spinner briefly. The request usually returns faster than a
        // frame, so without a floor the indicator never actually paints and
        // the button reads as dead.
        const elapsed = Date.now() - startedAt;
        if (elapsed < 400) await new Promise((r) => setTimeout(r, 400 - elapsed));
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    // FETCH ONCE. This tab does not poll — /display is the only page that
    // should, and only once it is paired. An admin screen quietly re-hitting
    // the API every fifteen seconds is exactly the traffic that principle
    // exists to avoid.
    //
    // The cost is that Live / Stale / Offline are only as fresh as the last
    // load, which is why the header says when that was: a liveness badge that
    // cannot go stale is fine, and one that can must admit it.
    void load();
  }, [load]);

  /** A 404 here means the row is GONE, not that something broke.
   *
   *  This tab fetches once and does not poll, so its list is only as fresh as
   *  the last load — a screen removed elsewhere (another operator, a cleanup)
   *  leaves a row that errors every time it is clicked. Re-reading turns a
   *  confusing failure into the row quietly disappearing, which is what the
   *  operator wanted anyway. */
  async function handleGoneOrReport(err: unknown, fallback: string) {
    const msg = getErrorMessage(fallback, err);
    if (/not found/i.test(msg)) {
      await load();
      publishInlineMessage({
        type: "INFO",
        text: "That screen was already disconnected. The list is up to date now.",
      });
      return;
    }
    publishInlineMessage({ type: "ERROR", text: msg });
  }

  /** The one call both pairing paths make. Adding a screen and taking one
   *  over are the same server operation — only `replaceDisplayId` differs —
   *  so they must not drift into two hand-written bodies. */
  async function submitPairing(args: {
    code: string;
    name: string;
    mode: "PUBLIC" | "PRIVATE";
    farViewing: boolean;
    replace: DisplayRow | null;
  }): Promise<boolean> {
    try {
      await apiPost("/api/super/displays/approve", {
        code: args.code.replace(/\D/g, ""),
        name: args.name.trim(),
        mode: args.mode,
        farViewing: args.farViewing,
        replaceDisplayId: args.replace?.id ?? null,
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: args.replace
          ? `${args.replace.name} re-paired to the screen showing that code. The old entry is gone.`
          : "Display paired. It will pick up the board within a minute.",
      });
      await load();
      return true;
    } catch (err) {
      // A pairing code that has expired or been used is the same shape of
      // problem, and the fix is the same: re-read so the pending list matches
      // what the server thinks.
      await handleGoneOrReport(err, "Could not pair that code");
      return false;
    }
  }

  async function approve() {
    setApproving(true);
    const ok = await submitPairing({ code, name, mode, farViewing, replace: null });
    if (ok) {
      setCode("");
      setName("");
    }
    setApproving(false);
  }

  /** RE-PAIR IS ONE ACTION, NOT TWO.
   *
   *  This used to prefill the add-a-screen form and leave the operator to
   *  find the Pair button further up the page — a click that visibly did
   *  nothing, followed by an act of faith. Everything a takeover needs is
   *  already known except the six digits, so the dialog asks for those and
   *  finishes the job. */
  async function submitRePair() {
    if (!rePairing) return;
    setRePairBusy(true);
    const ok = await submitPairing({
      code: rePairCode,
      name: rePairing.name,
      mode: rePairing.mode,
      farViewing: rePairing.farViewing,
      replace: rePairing,
    });
    setRePairBusy(false);
    // Stay open on failure — an expired or mistyped code is a retry, and
    // closing the dialog would throw away the context it was holding.
    if (ok) {
      setRePairing(null);
      setRePairCode("");
    }
  }

  async function setDisplayMode(row: DisplayRow, next: "PUBLIC" | "PRIVATE") {
    try {
      await apiPatch(`/api/super/displays/${row.id}`, { mode: next });
      publishInlineMessage({
        type: "SUCCESS",
        text: `${row.name} switched to ${next === "PRIVATE" ? "private" : "public"}. It changes over on its next refresh.`,
      });
      await load();
    } catch (err) {
      await handleGoneOrReport(err, "Could not change the mode");
    }
  }

  async function revoke(row: DisplayRow) {
    try {
      await apiPost(`/api/super/displays/${row.id}/revoke`, {});
      publishInlineMessage({
        type: "SUCCESS",
        text: `${row.name} disconnected. It drops back to a pairing code on its next refresh.`,
      });
      await load();
    } catch (err) {
      await handleGoneOrReport(err, "Could not disconnect that display");
    }
  }

  // Re-rendered by the refresh, not by a timer — this reports the age of the
  // reading at the moment you look, which is all it needs to do.
  const readingAge = useMemo(() => {
    if (!loadedAt) return null;
    const secs = Math.round((Date.now() - loadedAt) / 1000);
    if (secs < 45) return "just now";
    const mins = Math.round(secs / 60);
    return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  }, [loadedAt]);
  const distinctSources = useMemo(
    () => [...new Set(pending.map((p) => p.requestedIp ?? "unknown address"))],
    [pending],
  );
  const soonestExpiry = useMemo(() => {
    if (pending.length === 0) return null;
    const ms = Math.min(...pending.map((p) => new Date(p.expiresAt).getTime())) - Date.now();
    if (ms <= 0) return null;
    const mins = Math.ceil(ms / 60_000);
    return `${mins}m`;
  }, [pending]);
  const codeReady = code.replace(/\D/g, "").length === 6;
  // A name is REQUIRED. Screens are managed from a list, and "Display",
  // "Display", "Display" is a list you cannot act on — you would be revoking
  // by guesswork.
  const nameReady = name.trim().length > 0;

  const tabHelp = (
    <TabExplainer explainerId="seedlings:displaysTab:guideOpen">
      <ExplainerText>
        Screens that show a live board — a TV in the shop, a vertical panel in the waiting room.
        The screen opens <Em>/display</Em> in a normal browser; there is nothing to install.
      </ExplainerText>
      <ExplainerText>
        A screen shows six digits and you type them here. It is deliberately a code rather than a
        tap-to-approve list: typing what is <Em>on the wall</Em> is the step that ties the approval
        to the screen you are actually looking at.
      </ExplainerText>
      <ExplainerText>
        <Em>Public</Em> is the waiting room — crews&rsquo; first names, completed counts, promotions
        and hand-picked photos, and <Em>never</Em> a client name, address or price.{" "}
        <Em>Private</Em> is the back office: who is on the clock, what is in progress, what needs
        someone. A screen only ever gets the data its own mode allows, so a public panel cannot
        fetch client names even if someone takes the device.
      </ExplainerText>
      <ExplainerText>
        Photos from finished jobs appear on <Em>public</Em> screens on their own, newest first —
        there is nothing to switch on. To pull one down, open it on the job and choose{" "}
        <Em>Hide publicly</Em>: it stops appearing here and on the public activity feed, while the
        client still sees it on their invoice and in their own account.
      </ExplainerText>
      <ExplainerText>
        <Em>Testing two boards at once?</Em> One browser holds one screen — open{" "}
        <Em>/display</Em> in a second tab and it is the same screen again, because both tabs
        share one browser&rsquo;s storage. Add a name of your choosing to tell them apart:{" "}
        <Em>/display?slot=lobby</Em> and <Em>/display?slot=office</Em> pair separately and show
        different codes. A real screen on a wall never needs this.
      </ExplainerText>
      <ExplainerText>
        <Em>Disconnect</Em> takes effect on the screen&rsquo;s next refresh — under a minute, not
        instant. The screen then clears and shows a fresh pairing code rather than freezing on the
        last thing it had.
      </ExplainerText>
    </TabExplainer>
  );

  if (loading) return <>{tabHelp}<LoadingCenter /></>;

  return (
    <Box w="full">
      {tabHelp}

      <VStack align="stretch" gap={4}>
        {/* Pair a screen */}
        <Card.Root variant="outline">
          <Card.Header py="2" px="3" pb="0">
            <HStack justify="space-between">
              <Text fontWeight="semibold">Pair a screen</Text>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void load({ manual: true })}
                disabled={refreshing}
                title="Check for waiting screens and refresh liveness"
                aria-label="Refresh"
              >
                <Box
                  display="flex"
                  animation={refreshing ? "spin 700ms linear infinite" : undefined}
                  css={{ "@keyframes spin": { from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } } }}
                >
                  <RefreshCw size={13} />
                </Box>
                <Text ml={1.5} fontSize="xs">
                  {refreshing ? "Refreshing…" : "Refresh"}
                </Text>
              </Button>
            </HStack>
          </Card.Header>
          <Card.Body py="3" px="3">
            <VStack align="stretch" gap={3}>
              {pending.length > 0 ? (
                <Box borderWidth="1px" borderColor="blue.emphasized" bg="blue.subtle" borderRadius="md" p={2}>
                  <Text fontSize="xs" color="blue.fg" fontWeight="semibold" mb={1}>
                    {pending.length === 1 ? "A screen is waiting" : `${pending.length} screens are waiting`}
                  </Text>
                  {/* A SUMMARY, not one line per request. Every waiting screen
                      renders the same "code shown, from <ip>" line, so listing
                      them individually is ten identical rows that answer
                      nothing — and the codes deliberately are not shown here,
                      because typing what is ON THE WALL is the step that ties
                      the approval to the right screen. */}
                  <Text fontSize="xs" color="blue.fg">
                    {distinctSources.length === 1
                      ? `From ${distinctSources[0]}`
                      : `From ${distinctSources.length} addresses: ${distinctSources.slice(0, 3).join(", ")}${distinctSources.length > 3 ? "…" : ""}`}
                    {soonestExpiry ? ` · oldest expires in ${soonestExpiry}` : ""}
                  </Text>
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Type the digits you can see on the screen to approve it. Requests you ignore
                    expire on their own after ten minutes.
                  </Text>
                </Box>
              ) : (
                <Text fontSize="xs" color="fg.muted">
                  Open <Em>/display</Em> on the screen. It will show a six-digit code.
                </Text>
              )}

              <Box>
                <Text fontSize="xs" color="fg.muted" mb={1}>Code on the screen</Text>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                  // A phone number pad, because this is always used standing up.
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={7}
                  fontSize="2xl"
                  letterSpacing="0.3em"
                  textAlign="center"
                  fontFamily="mono"
                />
              </Box>

              <Box>
                <Text fontSize="xs" color="fg.muted" mb={1}>
                  Name it <Text as="span" color="red.fg">*</Text>
                </Text>
                <Input
                  size="sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Shop TV"
                />
                {!nameReady ? (
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Where is it? You will be picking this one out of a list later.
                  </Text>
                ) : null}
              </Box>

              <Box>
                <Text fontSize="xs" color="fg.muted" mb={1}>What it shows</Text>
                <Select.Root
                  collection={MODE_COLLECTION}
                  value={[mode]}
                  onValueChange={(e) => setMode((e.value?.[0] as "PUBLIC" | "PRIVATE") ?? "PUBLIC")}
                  size="sm"
                  positioning={{ strategy: "fixed", hideWhenDetached: true }}
                >
                  <Select.Control>
                    <Select.Trigger w="full" px="2">
                      <Select.ValueText />
                      {/* Every dropdown in the app wears a chevron — without it
                          this read as a text field rather than a control. */}
                      <Select.Indicator />
                    </Select.Trigger>
                  </Select.Control>
                  <Select.Positioner>
                    <Select.Content>
                      {MODE_COLLECTION.items.map((it) => (
                        <Select.Item key={it.value} item={it.value}>
                          <Select.ItemText>{it.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Positioner>
                </Select.Root>
              </Box>

              <HStack justify="space-between" align="center">
                <Box>
                  <Text fontSize="sm" fontWeight="semibold">Viewed from across the room</Text>
                  <Text fontSize="xs" color="fg.muted">
                    Turn off for a screen people walk up to — it uses smaller text.
                  </Text>
                </Box>
                <Switch.Root
                  checked={farViewing}
                  onCheckedChange={(d: any) => setFarViewing(!!d.checked)}
                  colorPalette="blue"
                >
                  <Switch.HiddenInput />
                  <Switch.Control />
                </Switch.Root>
              </HStack>

              <HStack justify="flex-end">
                <Button
                  size="sm"
                  colorPalette="blue"
                  disabled={!codeReady || !nameReady || approving}
                  loading={approving}
                  onClick={() => setConfirmApprove(true)}
                >
                  Pair screen
                </Button>
              </HStack>
            </VStack>
          </Card.Body>
        </Card.Root>

        {/* Connected screens */}
        <Card.Root variant="outline">
          <Card.Header py="2" px="3" pb="0">
            <HStack justify="space-between" align="baseline">
              <Text fontWeight="semibold">Connected screens</Text>
              {readingAge ? (
                <Text fontSize="2xs" color="fg.muted">Read {readingAge} · Refresh to update</Text>
              ) : null}
            </HStack>
          </Card.Header>
          <Card.Body py="3" px="3">
            {displays.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">No screens paired yet.</Text>
            ) : (
              <VStack align="stretch" gap={2}>
                {displays.map((d) => (
                  <Box key={d.id} borderWidth="1px" borderRadius="md" p={2}>
                    <HStack justify="space-between" align="start" flexWrap="wrap" gap={2}>
                      <HStack gap={2} align="center" minW={0}>
                        <Monitor size={15} />
                        <Box minW={0}>
                          <Text fontSize="sm" fontWeight="semibold">{d.name}</Text>
                          <Text fontSize="xs" color="fg.muted">
                            {d.lastSeenAt ? `Last seen ${fmtTimeOpts(d.lastSeenAt, { hour: "numeric", minute: "2-digit" })}` : "Never connected"}
                            {d.lastSeenIp ? ` · ${d.lastSeenIp}` : ""}
                          </Text>
                          {d.liveness === "offline" && d.quietDays >= 1 ? (
                            <Text fontSize="xs" color="orange.fg" mt={0.5}>
                              Quiet for {d.quietDays} day{d.quietDays === 1 ? "" : "s"}. If this screen was
                              wiped or replaced, re-pair it here rather than adding a new one.
                            </Text>
                          ) : null}
                        </Box>
                      </HStack>
                      <HStack gap={2}>
                        <Badge size="sm" colorPalette={LIVENESS[d.liveness].palette}>
                          {LIVENESS[d.liveness].label}
                        </Badge>
                        <Badge size="sm" colorPalette={d.mode === "PRIVATE" ? "purple" : "gray"} variant="subtle">
                          {d.mode === "PRIVATE" ? "Private" : "Public"}
                        </Badge>
                      </HStack>
                    </HStack>
                    <HStack mt={2} gap={2} justify="flex-end">
                      {/* On EVERY row, not just the quiet ones. A screen wiped
                          a minute ago still reads as live, and "is this the
                          same physical screen?" is a question only the operator
                          can answer — liveness is a poor proxy for it. */}
                      {(
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="orange"
                          onClick={() => {
                            // Opens the takeover dialog, which carries this
                            // screen's name and mode across on its own. The
                            // operator confirms a takeover; they never retype
                            // a name and hope the two match.
                            setRePairCode("");
                            setRePairing(d);
                          }}
                        >
                          Re-pair this screen
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void setDisplayMode(d, d.mode === "PRIVATE" ? "PUBLIC" : "PRIVATE")}
                      >
                        Switch to {d.mode === "PRIVATE" ? "public" : "private"}
                      </Button>
                      <Button size="xs" variant="outline" colorPalette="red" onClick={() => setConfirmRevoke(d)}>
                        <Trash2 size={12} /> Disconnect
                      </Button>
                    </HStack>
                  </Box>
                ))}
              </VStack>
            )}
          </Card.Body>
        </Card.Root>

      </VStack>

      <ConfirmDialog
        open={confirmApprove}
        title="Pair this screen?"
        message={
          mode === "PRIVATE"
            ? `"${name.trim()}" will show the back-office board: who is on the clock, jobs in progress, and what needs attention. Only pair a private screen somewhere clients cannot read it.`
            : `"${name.trim()}" will show the waiting-room board: crew first names, completed counts, promotions and hand-picked photos. No client names, addresses or prices.`
        }
        confirmLabel="Pair screen"
        confirmColorPalette="blue"
        onConfirm={() => {
          setConfirmApprove(false);
          void approve();
        }}
        onCancel={() => setConfirmApprove(false)}
      />

      {/* RE-PAIR: one click opens this, six digits and one more click finish
          it. Not a ConfirmDialog — that component's text input has no numeric
          keypad, and this field is typed standing in a shop on a phone. */}
      <Dialog.Root
        role="alertdialog"
        open={!!rePairing}
        onOpenChange={(e: any) => {
          if (!e.open && !rePairBusy) {
            setRePairing(null);
            setRePairCode("");
          }
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Re-pair {rePairing?.name}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm" color="fg.muted">
                    Hand <b>{rePairing?.name}</b> over to the screen showing a code right now. It
                    keeps its name and stays{" "}
                    {rePairing?.mode === "PRIVATE" ? "private — back office" : "public — waiting room"}.
                    The old entry is removed.
                  </Text>

                  {pending.length === 0 ? (
                    <Box borderWidth="1px" borderColor="orange.emphasized" bg="orange.subtle" borderRadius="md" p={2}>
                      <Text fontSize="xs" color="orange.fg">
                        No screen is waiting. Open <Em>/display</Em> on the screen first — it will
                        show six digits.
                      </Text>
                    </Box>
                  ) : (
                    <Text fontSize="xs" color="fg.muted">
                      {pending.length === 1 ? "A screen is waiting" : `${pending.length} screens are waiting`}
                      {soonestExpiry ? ` · oldest expires in ${soonestExpiry}` : ""}
                    </Text>
                  )}

                  <Box>
                    <Text fontSize="xs" color="fg.muted" mb={1}>Code on the screen</Text>
                    <Input
                      autoFocus
                      value={rePairCode}
                      onChange={(e) => setRePairCode(e.target.value)}
                      placeholder="000000"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={7}
                      fontSize="2xl"
                      letterSpacing="0.3em"
                      textAlign="center"
                      fontFamily="mono"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && rePairCode.replace(/\D/g, "").length === 6 && !rePairBusy) {
                          void submitRePair();
                        }
                      }}
                    />
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <VStack w="full" gap={2}>
                  <Button
                    w="full"
                    colorPalette="orange"
                    loading={rePairBusy}
                    disabled={rePairCode.replace(/\D/g, "").length !== 6 || rePairBusy}
                    onClick={() => void submitRePair()}
                  >
                    Re-pair {rePairing?.name}
                  </Button>
                  <Button
                    w="full"
                    variant="outline"
                    colorPalette="gray"
                    disabled={rePairBusy}
                    onClick={() => {
                      setRePairing(null);
                      setRePairCode("");
                    }}
                  >
                    Cancel
                  </Button>
                </VStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={!!confirmRevoke}
        title="Disconnect this screen?"
        message={
          confirmRevoke
            ? `"${confirmRevoke.name}" stops showing the board on its next refresh, within about a minute, and goes back to a pairing code. To use it again you will need to approve a new code from the screen.`
            : ""
        }
        confirmLabel="Disconnect"
        confirmColorPalette="red"
        onConfirm={() => {
          const row = confirmRevoke;
          setConfirmRevoke(null);
          if (row) void revoke(row);
        }}
        onCancel={() => setConfirmRevoke(null)}
      />
    </Box>
  );
}
