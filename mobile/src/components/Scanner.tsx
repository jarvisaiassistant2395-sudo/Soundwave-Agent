import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { CameraOff, KeyRound, X } from "lucide-react";
import { parsePairingLink, type PairingLink } from "../lib/protocol";
import { tap } from "../lib/native";
import { GhostButton, IconButton } from "./ui";

interface Detector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

function cameraProblem(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Soundwave needs the camera to scan the code. Allow it in Android Settings → Apps → Soundwave → Permissions → Camera — or enter the code instead.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found on this phone. Enter the code instead.";
  if (name === "NotReadableError") return "The camera is busy — close other apps using it, or enter the code instead.";
  return "The camera couldn't start. Enter the code instead.";
}

/** Full-screen camera that reads the PC's pairing QR code. */
export function Scanner({ onResult, onClose, onManual }: { onResult: (link: PairingLink) => void; onClose: () => void; onManual: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    let detector: Detector | null = null;
    try {
      detector = Native ? new Native({ formats: ["qr_code"] }) : null;
    } catch {
      detector = null;
    }

    const read = async (video: HTMLVideoElement): Promise<string | null> => {
      if (detector) {
        try {
          const hit = (await detector.detect(video))[0]?.rawValue;
          if (hit) return hit;
        } catch {
          detector = null; // not really supported here — jsQR from now on
        }
      }
      if (!ctx || !video.videoWidth) return null;
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
    };

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const loop = async () => {
          if (stopped || done.current) return;
          if (video.readyState >= 2) {
            const text = await read(video);
            if (text) {
              const link = parsePairingLink(text);
              if (link) {
                done.current = true;
                tap("medium");
                onResult(link);
                return;
              }
              setHint("That QR code isn't a Soundwave pairing code.");
            }
          }
          timer = setTimeout(() => void loop(), 110);
        };
        void loop();
      } catch (err) {
        setProblem(cameraProblem(err));
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-30 bg-black" data-testid="scanner">
      <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />

      {!problem && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative h-[68vw] max-h-80 w-[68vw] max-w-80 rounded-3xl shadow-[0_0_0_9999px_rgba(0,0,0,0.62)]">
            {(["left-0 top-0 border-l-4 border-t-4 rounded-tl-3xl", "right-0 top-0 border-r-4 border-t-4 rounded-tr-3xl", "bottom-0 left-0 border-b-4 border-l-4 rounded-bl-3xl", "bottom-0 right-0 border-b-4 border-r-4 rounded-br-3xl"] as const).map((c) => (
              <span key={c} className={`absolute h-10 w-10 border-cyan-300 ${c}`} />
            ))}
            <span className="absolute left-4 right-4 h-0.5 animate-scan rounded-full bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_12px_2px_rgba(34,211,238,0.6)]" />
          </div>
        </div>
      )}

      <div className="absolute inset-x-0 top-0 flex items-center gap-2 px-3 pt-safe">
        <IconButton label="Close" onClick={onClose} className="mt-2 bg-black/40 text-white">
          <X className="h-6 w-6" />
        </IconButton>
        <p className="mt-2 text-[16px] font-semibold text-white drop-shadow">Scan the code on your PC</p>
      </div>

      <div className="absolute inset-x-0 bottom-0 space-y-3 px-6 pb-safe">
        {problem ? (
          <div className="rounded-3xl border border-white/10 bg-panel/95 p-5 text-center">
            <CameraOff className="mx-auto h-8 w-8 text-amber-300" />
            <p className="mt-3 text-[15px] text-gray-200">{problem}</p>
          </div>
        ) : (
          <p className="text-center text-[14px] text-gray-200 drop-shadow">
            {hint ?? "Soundwave AI on your PC → Settings → Phone. Hold the phone about 20 cm from the screen."}
          </p>
        )}
        <div className="pb-5">
          <GhostButton onClick={onManual} icon={<KeyRound className="h-4 w-4" />} className="bg-black/50 text-white backdrop-blur">
            Enter code instead
          </GhostButton>
        </div>
      </div>
    </div>
  );
}
