// apps/web/src/ui/components/QRScannerDialog.tsx

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  Button,
  Input,
  Stack,
  Text,
  Box,
  HStack,
} from "@chakra-ui/react";
import { BrowserMultiFormatReader } from "@zxing/browser";

type Props = {
  open: boolean;
  onClose: () => void;
  onDetected: (slug: string) => void;
};

export default function QRScannerDialog({ open, onClose, onDetected }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [hasCamera, setHasCamera] = useState<boolean>(false);

  useEffect(() => {
    if (!open) return;

    let stream: MediaStream | null = null;
    const cleanupFns: Array<() => void> = [];
    let stopped = false;
    let done = false;

    // Error display timing
    let firstFrameAt: number | null = null;
    let showErrTimer: number | null = null;
    const ARM_ERROR_AFTER_MS = 3500;

    const armErrorTimer = () => {
      if (showErrTimer != null || done || stopped) return;
      const delay =
        Math.max(
          0,
          (firstFrameAt ?? Date.now()) + ARM_ERROR_AFTER_MS - Date.now()
        ) || ARM_ERROR_AFTER_MS;
      showErrTimer = window.setTimeout(() => {
        if (!done && !stopped) {
          setError(
            "Camera not detecting a code yet. Try repositioning, or use Upload/Manual."
          );
        }
      }, delay);
    };

    const clearErrorTimer = () => {
      if (showErrTimer != null) {
        clearTimeout(showErrTimer);
        showErrTimer = null;
      }
    };

    // Helper: only surface meaningful errors (ignore Abort/normal scan errors)
    function showMeaningfulError(e: unknown) {
      const name = (e as any)?.name as string | undefined;
      if (name === "AbortError" || name === "AbortException") return; // ignore
      if (
        name === "NotFoundException" ||
        name === "ChecksumException" ||
        name === "FormatException"
      )
        return; // normal
      if (name === "NotAllowedError") {
        setError(
          "Camera permission denied. You can use Upload or Manual instead."
        );
        return;
      }
      setError(String((e as any)?.message ?? "Camera error"));
    }

    async function start() {
      setError(null);

      try {
        // Detect if any camera exists (labels may be blank before permission)
        const devices = await navigator.mediaDevices?.enumerateDevices?.();
        const cam = devices?.some((d) => d.kind === "videoinput");
        setHasCamera(!!cam);

        // Start camera
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });

        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;

        // mark first playable frame
        const v = videoRef.current;
        const onFirstFrame = () => {
          if (firstFrameAt == null) {
            firstFrameAt = Date.now();
            armErrorTimer();
          }
        };
        const onPlaying = () => onFirstFrame();
        const onLoadedMeta = () => onFirstFrame();
        v.addEventListener("playing", onPlaying);
        v.addEventListener("loadedmetadata", onLoadedMeta);
        cleanupFns.push(() => {
          v.removeEventListener("playing", onPlaying);
          v.removeEventListener("loadedmetadata", onLoadedMeta);
        });

        await v.play();

        // Prefer native BarcodeDetector if available
        // @ts-ignore
        const BD = window.BarcodeDetector as any | undefined;
        if (BD) {
          const detector = new BD({ formats: ["qr_code"] });
          let raf = 0;

          const scan = async () => {
            if (stopped || done || !videoRef.current) return;
            try {
              const codes = await detector.detect(videoRef.current);
              const raw = codes?.[0]?.rawValue;
              if (raw) {
                done = true;
                clearErrorTimer();
                setError(null);
                stopAll();
                onDetected(String(raw).trim());
                return;
              }
            } catch (e) {
              // ignore per-frame errors; timer handles UX if needed
              // (do not setError here)
            }
            raf = requestAnimationFrame(scan);
          };

          raf = requestAnimationFrame(scan);
          cleanupFns.push(() => cancelAnimationFrame(raf));
          return; // don't start ZXing if BD is active
        }

        // ---------- ZXING FALLBACK ----------
        const reader = new BrowserMultiFormatReader();

        const controls = await reader.decodeFromConstraints(
          {
            audio: false,
            video: { facingMode: { ideal: "environment" } },
          },
          videoRef.current!,
          (result, err, ctrls) => {
            if (stopped || done) {
              try {
                ctrls?.stop();
              } catch {}
              return;
            }

            if (result) {
              done = true;
              clearErrorTimer();
              setError(null);
              try {
                ctrls?.stop();
              } catch {}
              stopAll();
              onDetected(result.getText().trim());
              return;
            }

            // Ignore all per-frame decode errors; rely on the grace timer for UX.
            // If you still want to surface *unexpected* errors, you could:
            // if (err) showMeaningfulError(err);
          }
        );

        cleanupFns.push(() => {
          try {
            controls?.stop();
          } catch {}
        });
        // -----------------------------------
      } catch (e) {
        // Only surface meaningful errors; ignore AbortError noise
        showMeaningfulError(e);
      }
    }

    function stopAll() {
      stopped = true;
      clearErrorTimer();
      cleanupFns.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
      cleanupFns.length = 0;
      if (stream) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {}
      }
      stream = null;
    }

    void start();
    return () => stopAll();
  }, [open, onDetected]);

  // Image upload → decode via ZXing
  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();

      const reader = new BrowserMultiFormatReader();
      const result = await reader.decodeFromImageElement(img);
      onDetected(result.getText().trim());
    } catch (e) {
      // Ignore AbortError from canceled loads; otherwise show a friendly message
      const name = (e as any)?.name;
      if (name !== "AbortError" && name !== "AbortException") {
        setError("Couldn’t read a QR from that image. Try a clearer photo.");
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={({ open }: { open: boolean }) => {
        if (!open) onClose();
      }}
      placement="center"
    >
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content
          maxW={{ base: "calc(100vw - 2rem)", sm: "420px" }}
          w="full"
          mx="auto"
          my={{ base: "1rem", sm: "10vh" }}
          maxH="80vh"
          overflowY="auto"
          bg="white"
          _dark={{ bg: "gray.800" }}
          borderRadius="lg"
          boxShadow="lg"
        >
          <Dialog.Header>Scan to Check Out</Dialog.Header>
          <Dialog.Body>
            <Stack gap="3">
              {hasCamera ? (
                <Box borderWidth="1px" borderRadius="md" overflow="hidden">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    style={{ width: "100%", height: "auto" }}
                  />
                </Box>
              ) : (
                <Text>No camera detected. Use “Upload” or “Manual”.</Text>
              )}

              {error && <Text color="red.500">{error}</Text>}

              {/* Fallbacks are always available */}
              <Stack gap="2">
                <HStack gap="2" wrap="wrap">
                  <Input type="file" accept="image/*" onChange={onUpload} />
                </HStack>

                <HStack gap="2" wrap="wrap">
                  <Input
                    placeholder="Enter code manually (e.g., mower-hrx217)"
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    maxW="320px"
                  />
                  <Button
                    onClick={() => manual.trim() && onDetected(manual.trim())}
                    disabled={!manual.trim()}
                  >
                    Continue
                  </Button>
                </HStack>
              </Stack>
            </Stack>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <Button variant="outline">Cancel</Button>
            </Dialog.CloseTrigger>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
