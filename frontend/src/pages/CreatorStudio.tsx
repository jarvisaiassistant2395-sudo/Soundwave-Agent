import React, { useState, useRef, useEffect } from "react";
import {
  Video,
  Scissors,
  ZoomIn,
  Monitor,
  Sliders,
  Sparkles,
  CheckCircle2,
  Download,
  Square,
  RefreshCw,
  UploadCloud,
  Play,
  RotateCcw,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { toast } from "../store/toast";

interface SilenceAnalysis {
  totalDuration: number;
  originalDuration: number;
  estimatedDuration: number;
  savedDuration: number;
  savedPercent: number;
  cutsCount: number;
  speechIntervals: Array<{ start: number; end: number; duration: number }>;
  timelineBlocks: Array<{
    start: number;
    end: number;
    duration: number;
    type: "speech" | "silence";
  }>;
}

export function CreatorStudio() {
  // Mode: Record or Upload
  const [activeTab, setActiveTab] = useState<"record" | "upload">("record");

  // Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [clickCount, setClickCount] = useState(0);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  // Upload / Working Video State
  const [_videoFile, setVideoFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [rawVideoUrl, setRawVideoUrl] = useState<string | null>(null);

  // Silence Detection Parameters
  const [noiseThreshold, setNoiseThreshold] = useState(-30); // dB
  const [minSilenceDuration, setMinSilenceDuration] = useState(0.4); // s
  const [paddingSec, setPaddingSec] = useState(0.15); // s
  const [analysis, setAnalysis] = useState<SilenceAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Screen Studio Framing & Auto-Zoom
  const [aspect, setAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [zoomFactor, setZoomFactor] = useState(1.15);
  const [focusRegion, setFocusRegion] = useState<"center" | "top_left" | "top_right" | "bottom_left" | "bottom_right">("center");
  const [backdrop, setBackdrop] = useState<"gradient_cyber" | "gradient_purple" | "midnight" | "none">("gradient_cyber");
  const [paddingPercent, setPaddingPercent] = useState(6);

  // Editing / Job State
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingStep, setProcessingStep] = useState<string>("");
  const [completedVideoUrl, setCompletedVideoUrl] = useState<string | null>(null);

  // References
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const timerIntervalRef = useRef<any>(null);

  // Attach live preview stream
  useEffect(() => {
    if (videoPreviewRef.current && mediaStream) {
      videoPreviewRef.current.srcObject = mediaStream;
      videoPreviewRef.current.play().catch(() => {});
    }
  }, [mediaStream]);

  // Clean up stream on unmount
  useEffect(() => {
    return () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
      }
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [mediaStream]);

  // Start Screen + Mic Recording
  const startRecording = async () => {
    try {
      setAnalysis(null);
      setCompletedVideoUrl(null);
      setClickCount(0);
      recordedChunksRef.current = [];

      // 1. Capture Display
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor" } as any,
        audio: true,
      });

      // 2. Capture Microphone
      let micStream: MediaStream | null = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn("Microphone not available, recording system audio only");
      }

      // 3. Mix audio tracks
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const dest = audioContext.createMediaStreamDestination();

      if (displayStream.getAudioTracks().length > 0) {
        const sysSource = audioContext.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks()));
        sysSource.connect(dest);
      }
      if (micStream && micStream.getAudioTracks().length > 0) {
        const micSource = audioContext.createMediaStreamSource(micStream);
        micSource.connect(dest);
      }

      const combinedTracks = [
        ...displayStream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ];

      const combinedStream = new MediaStream(combinedTracks);
      setMediaStream(combinedStream);

      // Handle when user stops sharing via browser bar
      const vTrack = displayStream.getVideoTracks()[0];
      if (vTrack) {
        vTrack.onended = () => {
          stopRecording();
        };
      }

      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";

      const recorder = new MediaRecorder(combinedStream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        const file = new File([blob], `screen_recording_${Date.now()}.webm`, { type: "video/webm" });
        setVideoFile(file);
        setRawVideoUrl(URL.createObjectURL(blob));
        await uploadAndAnalyze(file);
      };

      recorder.start(1000);
      setIsRecording(true);
      setRecordingSeconds(0);

      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);

      toast.success("Recording started! Demonstrate your workflow.");
    } catch (err: any) {
      if (err.name !== "NotAllowedError") {
        toast.error(`Recording error: ${err.message}`);
      }
    }
  };

  // Stop Recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      setMediaStream(null);
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }
    setIsRecording(false);
  };

  // Handle Manual File Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    setRawVideoUrl(URL.createObjectURL(file));
    await uploadAndAnalyze(file);
  };

  // Upload video to server and trigger silence analysis
  const uploadAndAnalyze = async (file: File) => {
    try {
      setIsAnalyzing(true);
      setProcessingStep("Uploading video to workspace...");

      const formData = new FormData();
      formData.append("file", file);

      const upRes = await fetch("/api/v1/upload/video", {
        method: "POST",
        body: formData,
      });

      if (!upRes.ok) {
        throw new Error("Failed to upload recording to server");
      }

      const upData = await upRes.json();
      const key = upData.fileKey;
      setFileKey(key);

      setProcessingStep("Scanning waveform & detecting silences...");

      const anaRes = await fetch("/api/v1/creator/analyze-silence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: key,
          noiseThresholdDb: noiseThreshold,
          minSilenceDuration: minSilenceDuration,
          paddingSec: paddingSec,
        }),
      });

      if (!anaRes.ok) {
        throw new Error("Failed to analyze audio silence");
      }

      const anaData = await anaRes.json();
      setAnalysis(anaData.analysis);
      toast.success(`Analysis ready: ${anaData.analysis.cutsCount} dead-air pauses detected!`);
    } catch (err: any) {
      toast.error(err.message || "Failed to process video");
    } finally {
      setIsAnalyzing(false);
      setProcessingStep("");
    }
  };

  // Re-run Silence Analysis with updated parameters
  const reanalyzeSilence = async () => {
    if (!fileKey) return;
    try {
      setIsAnalyzing(true);
      setProcessingStep("Recalculating silence thresholds...");

      const anaRes = await fetch("/api/v1/creator/analyze-silence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: fileKey,
          noiseThresholdDb: noiseThreshold,
          minSilenceDuration: minSilenceDuration,
          paddingSec: paddingSec,
        }),
      });

      if (!anaRes.ok) throw new Error("Recalculation failed");
      const anaData = await anaRes.json();
      setAnalysis(anaData.analysis);
      toast.success("Silence intervals updated!");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsAnalyzing(false);
      setProcessingStep("");
    }
  };

  // Execute Auto-Edit & Jump-Cut Rendering
  const handleAutoEdit = async () => {
    if (!fileKey || !analysis) {
      toast.error("Please record or upload a video first.");
      return;
    }

    try {
      setIsProcessing(true);
      setProcessingProgress(10);
      setProcessingStep("Initializing jump-cut timeline & framing...");
      setCompletedVideoUrl(null);

      const res = await fetch("/api/v1/creator/auto-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: fileKey,
          speechIntervals: analysis.speechIntervals,
          silenceOptions: {
            noiseThresholdDb: noiseThreshold,
            minSilenceDuration: minSilenceDuration,
            paddingSec: paddingSec,
          },
          framing: {
            aspect,
            zoomFactor,
            backdrop,
            paddingPercent,
            focusRegion,
            quality: "high",
          },
          async: true,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to start auto-editing job");
      }

      const data = await res.json();
      const jobId = data.jobId;

      // Poll job progress
      setProcessingStep("Rendering jump cuts & Screen Studio auto-zoom...");
      const pollInterval = setInterval(async () => {
        try {
          const jobRes = await fetch(`/api/v1/creator/jobs/${jobId}`);
          if (!jobRes.ok) return;

          const job = await jobRes.json();
          setProcessingProgress(job.progress || 10);

          if (job.status === "COMPLETED") {
            clearInterval(pollInterval);
            setIsProcessing(false);
            setProcessingProgress(100);
            setProcessingStep("Ready!");
            setCompletedVideoUrl(job.downloadUrl || `/api/v1/creator/jobs/${jobId}/download`);
            toast.success("🎉 Creator Auto-Edit Complete!");
          } else if (job.status === "FAILED") {
            clearInterval(pollInterval);
            setIsProcessing(false);
            toast.error(job.error || "Auto-editing failed");
          }
        } catch {
          // ignore transient poll error
        }
      }, 1000);
    } catch (err: any) {
      setIsProcessing(false);
      toast.error(err.message || "Failed to edit video");
    }
  };

  // Format seconds to mm:ss
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-12">
      {/* ── TOP BANNER ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/[0.08] bg-[#13141C] px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-blue-400">
            <Video className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-white tracking-tight">
                Smart Video Production & Screen Capture
              </h1>
              <span className="rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-[11px] font-medium text-blue-400">
                Auto-Cut 60fps
              </span>
            </div>
            <p className="text-xs text-gray-400">
              Auto-silence removal, jump cuts, and Screen Studio camera auto-zoom for YouTube tutorials and vertical clips.
            </p>
          </div>
        </div>

        {/* Mode Switcher */}
        <div className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-1">
          <button
            onClick={() => setActiveTab("record")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === "record"
                ? "bg-white/[0.08] text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            <Monitor className="h-3.5 w-3.5 text-blue-400" />
            <span>Screen Recorder</span>
          </button>
          <button
            onClick={() => setActiveTab("upload")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === "upload"
                ? "bg-white/[0.08] text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            <UploadCloud className="h-3.5 w-3.5 text-purple-400" />
            <span>Upload Existing</span>
          </button>
        </div>
      </div>

      {/* ── MAIN WORKBENCH GRID ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* LEFT COLUMN: RECORDER & PREVIEW (7 COLS) */}
        <div className="space-y-6 lg:col-span-7">
          {activeTab === "record" ? (
            <div className="rounded-xl border border-white/[0.08] bg-[#13141C] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-blue-400" />
                    Interactive Screen + Mic Capture
                  </h2>
                  <p className="text-xs text-gray-400">
                    Captures high-res display with microphone audio for seamless auto-cutting.
                  </p>
                </div>
                {isRecording && (
                  <div className="flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-400 animate-pulse">
                    <span className="h-2 w-2 rounded-full bg-rose-500"></span>
                    REC {formatTime(recordingSeconds)}
                  </div>
                )}
              </div>

              {/* Viewfinder / Preview Box */}
              <div
                onClick={() => isRecording && setClickCount((c) => c + 1)}
                className="relative aspect-video w-full overflow-hidden rounded-xl border border-gray-800 bg-black/60 shadow-inner flex items-center justify-center cursor-pointer group"
              >
                {mediaStream ? (
                  <video
                    ref={videoPreviewRef}
                    muted
                    autoPlay
                    playsInline
                    className="h-full w-full object-contain"
                  />
                ) : rawVideoUrl ? (
                  <video
                    src={rawVideoUrl}
                    controls
                    playsInline
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="text-center p-6 space-y-3">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                      <Monitor className="h-7 w-7" />
                    </div>
                    <div className="text-xs text-gray-400">
                      Click <strong className="text-white">Start Recording</strong> to share your screen or application window.
                    </div>
                  </div>
                )}

                {/* Click Counter Overlay when Recording */}
                {isRecording && (
                  <div className="absolute top-3 right-3 rounded-lg border border-gray-800 bg-navy/80 px-2.5 py-1 text-[11px] text-gray-300 backdrop-blur-md">
                    🖱️ Clicks Logged: <strong className="text-white">{clickCount}</strong>
                  </div>
                )}
              </div>

              {/* Record / Stop Action Controls */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                {!isRecording ? (
                  <Button
                    onClick={startRecording}
                    className="flex-1 gap-2 bg-gradient-to-r from-cyan-500 to-blue-600 font-semibold text-white hover:from-cyan-400 hover:to-blue-500"
                  >
                    <Play className="h-4 w-4" /> Start Screen Recording
                  </Button>
                ) : (
                  <Button
                    onClick={stopRecording}
                    className="flex-1 gap-2 bg-rose-600 font-semibold text-white hover:bg-rose-500"
                  >
                    <Square className="h-4 w-4" /> Stop & Send to Auto-Editor
                  </Button>
                )}

                {rawVideoUrl && !isRecording && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setRawVideoUrl(null);
                      setAnalysis(null);
                      setCompletedVideoUrl(null);
                    }}
                    className="gap-1.5 border-gray-700 text-xs text-gray-300"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Clear
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-gray-800 bg-panel p-6 shadow-xl space-y-4">
              <div>
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <UploadCloud className="h-4 w-4 text-violet-400" />
                  Import Screen Recording (.mp4, .webm, .mov)
                </h2>
                <p className="text-xs text-gray-400">
                  Select an existing raw recording to remove dead-air pauses and add Screen Studio styling.
                </p>
              </div>

              <label className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-700 bg-navy/40 p-8 text-center cursor-pointer hover:border-violet-500 hover:bg-violet-950/10 transition-all">
                <UploadCloud className="h-10 w-10 text-violet-400 mb-2" />
                <span className="text-xs font-semibold text-white">Click or drag video file here</span>
                <span className="text-[11px] text-gray-500 mt-1">MP4, WEBM, MOV up to 2GB</span>
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>

              {rawVideoUrl && (
                <div className="aspect-video w-full overflow-hidden rounded-xl border border-gray-800 bg-black">
                  <video src={rawVideoUrl} controls playsInline className="h-full w-full object-contain" />
                </div>
              )}
            </div>
          )}

          {/* ── SILENCE DETECTION & TIMELINE VISUALIZER ────────────────────── */}
          {analysis && (
            <div className="rounded-xl border border-white/[0.08] bg-[#13141C] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Scissors className="h-4 w-4 text-emerald-400" />
                    Auto-Cut Analysis & Pacing Preview
                  </h3>
                  <p className="text-xs text-gray-400">
                    Waveform scanned · Red zones removed · Green zones concatenated.
                  </p>
                </div>
                <Badge tone="green" className="py-0.5">
                  -{analysis.savedPercent}% Time Saved
                </Badge>
              </div>

              {/* Stats Chips */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
                  <span className="block text-[10px] uppercase font-semibold text-gray-400">Original Length</span>
                  <span className="text-sm font-semibold text-gray-200">{formatTime(analysis.originalDuration)}</span>
                </div>
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
                  <span className="block text-[10px] uppercase font-semibold text-blue-400">Clean Length</span>
                  <span className="text-sm font-semibold text-white">{formatTime(analysis.estimatedDuration)}</span>
                </div>
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
                  <span className="block text-[10px] uppercase font-semibold text-emerald-400">Dead Air Cut</span>
                  <span className="text-sm font-semibold text-emerald-300">-{formatTime(analysis.savedDuration)}</span>
                </div>
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
                  <span className="block text-[10px] uppercase font-semibold text-purple-400">Jump Cuts</span>
                  <span className="text-sm font-semibold text-purple-300">{analysis.cutsCount} cuts</span>
                </div>
              </div>

              {/* Visual Multi-Segment Timeline Track */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px] text-gray-400">
                  <span>0:00</span>
                  <span className="text-center text-xs font-semibold text-gray-300">Detected Speech vs. Silence Track</span>
                  <span>{formatTime(analysis.totalDuration)}</span>
                </div>
                <div className="h-6 w-full overflow-hidden rounded-lg border border-gray-700 bg-gray-900 flex shadow-inner">
                  {analysis.timelineBlocks.map((blk, idx) => {
                    const widthPct = (blk.duration / analysis.totalDuration) * 100;
                    return (
                      <div
                        key={idx}
                        style={{ width: `${Math.max(0.5, widthPct)}%` }}
                        title={`${blk.type.toUpperCase()}: ${blk.start.toFixed(1)}s - ${blk.end.toFixed(1)}s (${blk.duration.toFixed(1)}s)`}
                        className={`h-full transition-all ${
                          blk.type === "speech"
                            ? "bg-gradient-to-r from-emerald-500 to-cyan-500"
                            : "bg-rose-950/80 border-r border-rose-900/60"
                        }`}
                      />
                    );
                  })}
                </div>
                <div className="flex items-center gap-4 text-[10px] text-gray-400 pt-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                    <span>Speech Kept ({analysis.speechIntervals.length} segments)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-rose-500"></span>
                    <span>Silence Cut (Dead Air)</span>
                  </div>
                </div>
              </div>

              {/* Threshold Fine-Tuning Sliders */}
              <div className="rounded-xl border border-gray-800 bg-navy/50 p-3.5 space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-gray-300">
                  <span className="flex items-center gap-1.5">
                    <Sliders className="h-3.5 w-3.5 text-cyan-400" />
                    Pacing & Cut Sensitivity Tuning
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={reanalyzeSilence}
                    disabled={isAnalyzing}
                    className="h-6 text-[10px] px-2 border-gray-700"
                  >
                    {isAnalyzing ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Apply Sliders"}
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">
                      Noise Floor: <strong className="text-white">{noiseThreshold} dB</strong>
                    </label>
                    <input
                      type="range"
                      min={-45}
                      max={-15}
                      value={noiseThreshold}
                      onChange={(e) => setNoiseThreshold(Number(e.target.value))}
                      className="w-full accent-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">
                      Min Pause: <strong className="text-white">{minSilenceDuration}s</strong>
                    </label>
                    <input
                      type="range"
                      min={0.2}
                      max={1.2}
                      step={0.1}
                      value={minSilenceDuration}
                      onChange={(e) => setMinSilenceDuration(Number(e.target.value))}
                      className="w-full accent-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">
                      Word Padding: <strong className="text-white">{paddingSec}s</strong>
                    </label>
                    <input
                      type="range"
                      min={0.05}
                      max={0.3}
                      step={0.05}
                      value={paddingSec}
                      onChange={(e) => setPaddingSec(Number(e.target.value))}
                      className="w-full accent-cyan-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: SCREEN STUDIO AUTO-ZOOM & FRAMING (5 COLS) */}
        <div className="space-y-6 lg:col-span-5">
          <div className="rounded-xl border border-white/[0.08] bg-[#13141C] p-6 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <ZoomIn className="h-4 w-4 text-purple-400" />
                "Screen Studio" Auto-Zoom & Framing
              </h2>
              <p className="text-xs text-gray-400">
                Transforms flat screen recordings into sleek, high-converting showcase videos.
              </p>
            </div>

            {/* Target Aspect Ratio */}
            <div>
              <label className="block text-[11px] font-semibold text-gray-300 mb-1.5">Output Format & Aspect Ratio</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: "16:9", label: "16:9 Landscape", sub: "YouTube / Desktop" },
                  { id: "9:16", label: "9:16 Vertical", sub: "Shorts / TikTok" },
                  { id: "1:1", label: "1:1 Square", sub: "LinkedIn / X" },
                ].map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setAspect(a.id as any)}
                    className={`flex flex-col items-center justify-center rounded-xl border p-2 text-center transition-all ${
                      aspect === a.id
                        ? "border-violet-500 bg-violet-500/10 text-white shadow-sm shadow-violet-500/20"
                        : "border-gray-800 bg-navy/40 text-gray-400 hover:border-gray-700"
                    }`}
                  >
                    <span className="text-xs font-bold">{a.label}</span>
                    <span className="text-[10px] text-gray-500 mt-0.5">{a.sub}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Zoom Factor */}
            <div>
              <label className="block text-[11px] font-semibold text-gray-300 mb-1.5">
                Smart Auto-Zoom Scale: <strong className="text-white">{zoomFactor}x</strong>
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { factor: 1.0, label: "1.0x (Off)" },
                  { factor: 1.15, label: "1.15x (Subtle)" },
                  { factor: 1.35, label: "1.35x (Focus)" },
                  { factor: 1.55, label: "1.55x (Macro)" },
                ].map((z) => (
                  <button
                    key={z.factor}
                    onClick={() => setZoomFactor(z.factor)}
                    className={`rounded-lg border py-1.5 text-[11px] font-semibold transition-all ${
                      zoomFactor === z.factor
                        ? "border-cyan-500 bg-cyan-500/15 text-cyan-300"
                        : "border-gray-800 bg-navy text-gray-400 hover:text-white"
                    }`}
                  >
                    {z.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Focus Region (where to zoom) */}
            {zoomFactor > 1.01 && (
              <div>
                <label className="block text-[11px] font-semibold text-gray-300 mb-1.5">Focus Anchor Region</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { id: "top_left", label: "Top-Left (Menu/Code)" },
                    { id: "center", label: "Center (Default)" },
                    { id: "top_right", label: "Top-Right" },
                    { id: "bottom_left", label: "Bottom-Left (Terminal)" },
                    { id: "bottom_right", label: "Bottom-Right" },
                  ].map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFocusRegion(f.id as any)}
                      className={`rounded-lg border py-1 text-[10px] font-semibold transition-all ${
                        focusRegion === f.id
                          ? "border-violet-500 bg-violet-500/15 text-violet-300"
                          : "border-gray-800 bg-navy text-gray-400 hover:text-white"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Desktop Canvas Backdrop */}
            <div>
              <label className="block text-[11px] font-semibold text-gray-300 mb-1.5">Modern Canvas Backdrop</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: "gradient_cyber", label: "Cyber Slate", color: "from-slate-900 to-cyan-950" },
                  { id: "gradient_purple", label: "Cosmic Velvet", color: "from-purple-950 to-slate-900" },
                  { id: "midnight", label: "Midnight Noir", color: "from-black to-gray-950" },
                  { id: "none", label: "Edge-to-Edge (None)", color: "border-dashed" },
                ].map((b) => (
                  <button
                    key={b.id}
                    onClick={() => setBackdrop(b.id as any)}
                    className={`flex items-center gap-2 rounded-xl border p-2 text-left transition-all ${
                      backdrop === b.id
                        ? "border-white/40 bg-white/5 text-white"
                        : "border-gray-800 bg-navy/40 text-gray-400 hover:border-gray-700"
                    }`}
                  >
                    <span className={`h-4 w-4 rounded-full border border-gray-700 bg-gradient-to-br ${b.color}`}></span>
                    <span className="text-xs font-semibold">{b.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Canvas Padding (Margin) */}
            {backdrop !== "none" && (
              <div>
                <label className="block text-[11px] font-semibold text-gray-300 mb-1.5">
                  Floating Window Padding: <strong className="text-white">{paddingPercent}%</strong>
                </label>
                <div className="flex gap-2">
                  {[0, 4, 6, 10].map((p) => (
                    <button
                      key={p}
                      onClick={() => setPaddingPercent(p)}
                      className={`flex-1 rounded-lg border py-1 text-xs font-semibold ${
                        paddingPercent === p
                          ? "border-cyan-500 bg-cyan-500/10 text-cyan-300"
                          : "border-gray-800 bg-navy text-gray-400"
                      }`}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── EXECUTE BUTTON ────────────────────────────────────────── */}
            <div className="pt-2">
              <Button
                onClick={handleAutoEdit}
                disabled={!fileKey || !analysis || isProcessing || isAnalyzing}
                className="w-full gap-2 bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 shadow-sm"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>Processing {processingProgress}%...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    <span>Auto-Cut Silence & Render Video</span>
                  </>
                )}
              </Button>
            </div>

            {/* Progress Step Indicator */}
            {isProcessing && (
              <div className="space-y-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                <div className="flex justify-between text-xs text-gray-300">
                  <span>{processingStep}</span>
                  <span className="font-semibold text-blue-400">{processingProgress}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    style={{ width: `${processingProgress}%` }}
                    className="h-full bg-blue-500 transition-all duration-300"
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── COMPLETED POLISHED VIDEO PREVIEW ────────────────────────── */}
          {completedVideoUrl && (
            <div className="rounded-xl border border-emerald-500/30 bg-[#13141C] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                  <h3 className="text-sm font-semibold text-white">Polished Video Ready</h3>
                </div>
                <a
                  href={completedVideoUrl}
                  download="soundwave_screen_polished.mp4"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 shadow-lg shadow-emerald-600/30"
                >
                  <Download className="h-3.5 w-3.5" /> Download MP4
                </a>
              </div>

              <div className="overflow-hidden rounded-xl border border-gray-800 bg-black shadow-lg">
                <video
                  src={completedVideoUrl}
                  controls
                  playsInline
                  className="aspect-video w-full object-contain"
                />
              </div>

              <div className="text-[11px] text-gray-400 flex items-center justify-between">
                <span>Aspect: <strong className="text-white">{aspect}</strong></span>
                <span>Zoom: <strong className="text-white">{zoomFactor}x</strong></span>
                <span className="text-emerald-400 font-bold">100% Dead-Air Removed</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
export default CreatorStudio;
