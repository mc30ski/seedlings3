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
    let done = false; // prevent late callbacks after success

    // Grace/threshold controls for early/ephemeral errors
    const STARTED_AT = Date.now();
    let unexpectedErrs = 0;
    const ERROR_GRACE_MS = 1200; // don't show errors for the first ~1.2s
    const ERROR_THRESHOLD = 2; // require 2 unexpected errors before showing UI

    async function start() {
      setError(null);

      try {
        // Detect if any camera exists (labels may be blank before permission)
        const devices = await navigator.mediaDevices?.enumerateDevices?.();
        const cam = devices?.some((d) => d.kind === "videoinput");
        setHasCamera(!!cam);

        // Start a stream so the <video> shows preview regardless of detector
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

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
                setError(null); // clear any transient error
                stopAll();
                onDetected(String(raw).trim());
                return;
              }
            } catch {
              // ignore per-frame detect errors
            }
            raf = requestAnimationFrame(scan);
          };

          raf = requestAnimationFrame(scan);
          cleanupFns.push(() => cancelAnimationFrame(raf));
          return; // If BD path is active, do not start ZXing
        }

        // ---------- ZXING FALLBACK (when BarcodeDetector is not present) ----------
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
              setError(null); // clear any transient error
              try {
                ctrls?.stop();
              } catch {}
              stopAll();
              onDetected(result.getText().trim());
              return;
            }

            // Ignore common per-frame decode errors; only show unexpected ones,
            // and only after a grace window + enough consecutive occurrences.
            if (err && typeof err === "object") {
              const name = (err as any).name as string | undefined;

              if (
                name === "NotFoundException" ||
                name === "ChecksumException" ||
                name === "FormatException"
              ) {
                return; // normal while scanning
              }

              // Too soon after opening? Don't show an error yet.
              if (Date.now() - STARTED_AT < ERROR_GRACE_MS) {
                return;
              }

              unexpectedErrs += 1;
              if (unexpectedErrs >= ERROR_THRESHOLD && !done && !stopped) {
                setError(
                  "Camera error. Try repositioning, or use Upload/Manual."
                );
              }
            }
          }
        );

        // Ensure we stop controls on cleanup
        cleanupFns.push(() => {
          try {
            controls?.stop();
          } catch {}
        });
        // -------------------------------------------------------------------------
      } catch (e: any) {
        setError(e?.message ?? "Unable to access camera");
      }
    }

    function stopAll() {
      stopped = true;
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
    } catch {
      setError("Couldn’t read a QR from that image. Try a clearer photo.");
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
