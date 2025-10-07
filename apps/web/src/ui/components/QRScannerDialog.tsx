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
// FIX: only import BrowserMultiFormatReader (NotFoundException is *not* exported here)
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
        // (fast + low CPU/battery)
        // @ts-ignore
        const BD = window.BarcodeDetector as any | undefined;
        if (BD) {
          const detector = new BD({ formats: ["qr_code"] });
          let raf = 0;

          const scan = async () => {
            if (stopped || !videoRef.current) return;
            try {
              // BarcodeDetector can detect directly from <video> in modern browsers
              const codes = await detector.detect(videoRef.current);
              const raw = codes?.[0]?.rawValue;
              if (raw) {
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
        // FIX: use decodeFromConstraints (no need for listVideoInputDevices static)
        const reader = new BrowserMultiFormatReader();

        // Start continuous decode with your own constraints (rear cam when available)
        // NOTE: this returns "controls" (stop, switchTorch, etc.) — we keep a ref to stop on cleanup
        const controls = await reader.decodeFromConstraints(
          {
            audio: false,
            video: {
              facingMode: { ideal: "environment" },
            },
          },
          videoRef.current!,
          (result, err, ctrls) => {
            if (stopped) {
              try {
                ctrls?.stop();
              } catch {}
              return;
            }

            if (result) {
              // Got a code
              try {
                ctrls?.stop();
              } catch {}
              stopAll();
              onDetected(result.getText().trim());
              return;
            }

            // FIX: we don't import NotFoundException; just ignore "not found" by name
            if (
              err &&
              typeof err === "object" &&
              (err as any)?.name &&
              (err as any).name !== "NotFoundException"
            ) {
              setError(
                "Scanning error: " + String((err as any).message ?? err)
              );
            }
          }
        );

        // Ensure we stop controls on cleanup
        cleanupFns.push(() => {
          try {
            // FIX: BrowserMultiFormatReader instance may not have reset(); use controls.stop()
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

                <Text fontSize="xs" color="gray.600">
                  Tip: The QR can encode just the slug (e.g. <i>mower-hrx217</i>
                  ) or a URL that contains it. If you encode a URL, parse out
                  the slug before verifying.
                </Text>
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
