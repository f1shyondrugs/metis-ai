"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Mic, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type VoiceInputProps = {
  chatId?: string | null;
  onTranscript: (text: string) => void;
  onRecordingChange?: (recording: boolean) => void;
  onStateChange?: (state: VoiceState) => void;
  onWaveformLevelChange?: (level: number) => void;
  enabled?: boolean;
  maxDurationSeconds?: number;
  provider?: "openai" | "local" | "custom" | "browser";
  modelId?: string;
  realtime?: boolean;
  endpoint?: string;
  connectionId?: string;
  stopSignal?: number;
  cancelSignal?: number;
  onOpenSettings?: () => void;
};

export type VoiceState = "idle" | "permission" | "recording" | "uploading" | "transcribing" | "ready" | "error";
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function VoiceInput({
  chatId,
  onTranscript,
  onRecordingChange,
  onStateChange,
  onWaveformLevelChange,
  enabled = true,
  maxDurationSeconds,
  provider = "openai",
  modelId = "whisper-1",
  realtime = false,
  endpoint,
  connectionId,
  stopSignal = 0,
  cancelSignal = 0,
  onOpenSettings,
}: VoiceInputProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [maxDuration, setMaxDuration] = useState(300);
  const [lastRecording, setLastRecording] = useState<{ blob: Blob; duration: number } | null>(null);
  const [level, setLevel] = useState(0);
  const [livePreview, setLivePreview] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const waveformPeakRef = useRef(0.12);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const livePreviewRef = useRef("");
  const discardingRef = useRef(false);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const startedAtRef = useRef(0);
  const lastStopSignalRef = useRef(stopSignal);
  const lastCancelSignalRef = useRef(cancelSignal);
  const setRecording = useCallback((recording: boolean) => {
    onRecordingChange?.(recording);
  }, [onRecordingChange]);
  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);
  const commitTranscript = useCallback((text: string) => {
    const transcript = text.trim();
    if (transcript) onTranscript(transcript);
    setLivePreview("");
    livePreviewRef.current = "";
    setLevel(0);
    onWaveformLevelChange?.(0);
    setRecording(false);
    setState("idle");
  }, [onTranscript, onWaveformLevelChange, setRecording]);
  useEffect(() => {
    if (typeof maxDurationSeconds === "number") {
      setMaxDuration(Math.max(1, Math.min(3600, Math.floor(maxDurationSeconds))));
      return;
    }
    void fetch("/api/preferences", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => {
        const value = body.settings?.voiceInput?.maxDurationSeconds;
        if (typeof value === "number" && Number.isFinite(value)) setMaxDuration(Math.max(1, Math.min(3600, Math.floor(value))));
      })
      .catch(() => undefined);
  }, [maxDurationSeconds]);

  const cleanup = useCallback(() => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const startVisualizer = useCallback((stream: MediaStream) => {
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return;
    const audioContext = new AudioContextClass();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    waveformPeakRef.current = 0.12;
    const data = new Uint8Array(analyser.fftSize);
    const animate = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const rawLevel = Math.sqrt(sum / data.length) * 9;
      const gatedLevel = Math.max(0, rawLevel - 0.06);
      waveformPeakRef.current = Math.max(gatedLevel, waveformPeakRef.current * 0.997);
      const nextLevel = gatedLevel === 0
        ? 0
        : Math.min(1, gatedLevel / Math.max(0.1, waveformPeakRef.current * 0.55));
      setLevel(nextLevel);
      onWaveformLevelChange?.(nextLevel);
      animationFrameRef.current = requestAnimationFrame(animate);
    };
    animate();
  }, [onWaveformLevelChange]);

  const stop = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
      cleanup();
      if (livePreviewRef.current) commitTranscript(livePreviewRef.current);
      else {
        setState("error");
        setError("No speech was detected.");
        setRecording(false);
      }
      return;
    }
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setRecording(false);
    recorder.stop();
  }, [cleanup, commitTranscript, setRecording]);

  useEffect(() => {
    if (lastStopSignalRef.current === stopSignal) return;
    lastStopSignalRef.current = stopSignal;
    if (state === "recording") stop();
  }, [state, stop, stopSignal]);

  useEffect(() => {
    if (state !== "recording") return;
    const updateElapsed = () => {
      const seconds = Math.floor((Date.now() - startedAtRef.current) / 1_000);
      setElapsed(seconds);
      if (seconds >= maxDuration) stop();
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [state, maxDuration, stop]);

  const transcribe = useCallback(async (blob: Blob, duration: number) => {
    setState("uploading");
    setError("");
    const form = new FormData();
    form.append("file", blob, `recording-${Date.now()}.webm`);
    form.append("durationSeconds", String(duration));
    if (chatId) form.append("chatId", chatId);
    form.append("provider", provider);
    form.append("modelId", modelId);
    form.append("realtime", String(realtime));
    if (endpoint) form.append("endpoint", endpoint);
    if (connectionId) form.append("connectionId", connectionId);
    setState("transcribing");
    try {
      const response = await fetch("/api/voice/transcribe", {
        method: "POST",
        headers: { "Idempotency-Key": `${Date.now()}-${Math.random()}` },
        body: form,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.transcript !== "string") throw new Error(body.error || "Transcription failed.");
      commitTranscript(body.transcript);
    } catch (cause) {
      setState("error");
      setError(cause instanceof Error ? cause.message : "Transcription failed.");
      setRecording(false);
    }
  }, [chatId, connectionId, endpoint, modelId, commitTranscript, provider, realtime, setRecording]);

  const start = async () => {
    if (provider === "browser") {
      const speechWindow = window as Window & {
        SpeechRecognition?: new () => SpeechRecognitionLike;
        webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      };
      const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        setState("error");
        setError("Browser transcription is not supported in this browser.");
        return;
      }
      if (navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          streamRef.current = stream;
          startVisualizer(stream);
        } catch {
          // SpeechRecognition can still provide a transcript without the visualizer stream.
        }
      }
      const recognition = new SpeechRecognition();
      speechRecognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        let text = "";
        for (let index = 0; index < event.results.length; index += 1) text += `${event.results[index][0].transcript} `;
        livePreviewRef.current = text.trim();
        setLivePreview(livePreviewRef.current);
      };
      recognition.onerror = (event) => {
        speechRecognitionRef.current = null;
        cleanup();
        if (discardingRef.current) {
          discardingRef.current = false;
          return;
        }
        setState("error");
        setError(event.error || "Browser transcription failed.");
        setRecording(false);
      };
      recognition.onend = () => {
        speechRecognitionRef.current = null;
        cleanup();
        if (discardingRef.current) {
          discardingRef.current = false;
          return;
        }
        if (livePreviewRef.current) commitTranscript(livePreviewRef.current);
        else {
          setState("error");
          setError("No speech was detected.");
          setRecording(false);
        }
      };
      setLivePreview("");
      livePreviewRef.current = "";
      setElapsed(0);
      startedAtRef.current = Date.now();
      setState("recording");
      setRecording(true);
      recognition.start();
      return;
    }
    if (provider === "openai" && realtime) {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
        setState("error");
        setError("Realtime voice is not supported in this browser.");
        return;
      }
      setState("permission");
      setError("");
      try {
        const tokenResponse = await fetch("/api/voice/realtime", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelId, connectionId }),
        });
        const tokenBody = await tokenResponse.json().catch(() => ({}));
        const token = tokenBody.client_secret?.value;
        if (!tokenResponse.ok || typeof token !== "string") throw new Error(tokenBody.error || "Could not start realtime voice.");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        startVisualizer(stream);
        const peer = new RTCPeerConnection();
        peerConnectionRef.current = peer;
        for (const track of stream.getTracks()) peer.addTrack(track, stream);
        const channel = peer.createDataChannel("oai-events");
        channel.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data) as { type?: string; delta?: string; transcript?: string };
            if (payload.type?.includes("transcription.delta") || payload.type === "response.audio_transcript.delta") {
              livePreviewRef.current += payload.delta || "";
              setLivePreview(livePreviewRef.current);
            } else if (payload.type?.includes("transcription.completed") && payload.transcript) {
              livePreviewRef.current = payload.transcript;
              setLivePreview(payload.transcript);
            }
          } catch {
            // Ignore non-JSON realtime events.
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const sdpResponse = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(modelId)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
          body: offer.sdp,
        });
        if (!sdpResponse.ok) throw new Error("Could not connect to the realtime voice service.");
        await peer.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
        livePreviewRef.current = "";
        setLivePreview("");
        startedAtRef.current = Date.now();
        setElapsed(0);
        setState("recording");
        setRecording(true);
      } catch (cause) {
        peerConnectionRef.current?.close();
        peerConnectionRef.current = null;
        cleanup();
        setState("error");
        setError(cause instanceof Error ? cause.message : "Realtime voice failed.");
      }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("error");
      setError("This browser does not support microphone recording.");
      return;
    }
    setState("permission");
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsed(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (discardingRef.current) {
          discardingRef.current = false;
          cleanup();
          return;
        }
        const duration = Math.max(1, Math.min(maxDuration, Math.floor((Date.now() - startedAtRef.current) / 1_000)));
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        cleanup();
        setLastRecording({ blob, duration });
        void transcribe(blob, duration);
      };
      startVisualizer(stream);
      recorder.start(250);
      setState("recording");
      setRecording(true);
    } catch (cause) {
      cleanup();
      setState("error");
      setError(cause instanceof Error ? cause.message : "Microphone permission was denied.");
    }
  };

  const discard = useCallback(() => {
    const hasSpeechRecognition = Boolean(speechRecognitionRef.current);
    const hasRecorder = recorderRef.current?.state === "recording";
    discardingRef.current = hasSpeechRecognition || hasRecorder;
    speechRecognitionRef.current?.stop();
    speechRecognitionRef.current = null;
    if (hasRecorder) recorderRef.current?.stop();
    cleanup();
    setLastRecording(null);
    setElapsed(0);
    setLevel(0);
    onWaveformLevelChange?.(0);
    setLivePreview("");
    livePreviewRef.current = "";
    setError("");
    setState("idle");
    setRecording(false);
    if (!hasSpeechRecognition && !hasRecorder) discardingRef.current = false;
  }, [cleanup, onWaveformLevelChange, setRecording]);

  useEffect(() => {
    if (enabled) return;
    discard();
  }, [discard, enabled]);

  useEffect(() => {
    if (lastCancelSignalRef.current === cancelSignal) return;
    lastCancelSignalRef.current = cancelSignal;
    discard();
  }, [cancelSignal, discard]);

  useEffect(() => () => {
    discardingRef.current = true;
    speechRecognitionRef.current?.stop();
    peerConnectionRef.current?.close();
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    cleanup();
    setRecording(false);
    onStateChange?.("idle");
    onWaveformLevelChange?.(0);
  }, [cleanup, onStateChange, onWaveformLevelChange, setRecording]);

  if (!enabled) return null;

  const voiceConfigured = provider === "browser" || Boolean(connectionId);

  return (
    <div className="flex items-center gap-1">
      {state !== "recording" ? (
        voiceConfigured ? (
          <Button type="button" size="icon" variant="ghost" className="size-11 shrink-0 rounded-full sm:size-9" onClick={() => void start()} disabled={["permission", "uploading", "transcribing"].includes(state)} aria-label="Record voice input" title="Record voice input">
            <Mic className="size-4" />
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex" tabIndex={0}>
                <Button type="button" size="icon" variant="ghost" className="size-11 shrink-0 rounded-full text-muted-foreground/50 sm:size-9" disabled aria-label="Voice input requires an API key">
                  <Mic className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 flex-col items-start">
              <span>Richte zuerst den API-Key für Voice ein, bevor du die Voice-Funktion nutzt.</span>
              <button type="button" className="font-medium text-primary-foreground underline underline-offset-2" onClick={onOpenSettings}>
                Open voice settings
              </button>
            </TooltipContent>
          </Tooltip>
        )
      ) : null}
      {state === "recording" ? <span className="mr-2 text-[10px] tabular-nums text-red-400">{formatDuration(elapsed)}</span> : null}
      {provider === "browser" && livePreview ? <span className="max-w-48 truncate text-[11px] italic text-muted-foreground" title={livePreview}>{livePreview}</span> : null}
      {state === "ready" ? (
        <>
          <Button type="button" size="icon-xs" variant="secondary" onClick={() => {
            if (provider === "browser" || (provider === "openai" && realtime)) {
              commitTranscript(livePreview);
            } else if (lastRecording) {
              void transcribe(lastRecording.blob, lastRecording.duration);
            }
          }} aria-label="Confirm voice input" title="Confirm voice input">
            <Check className="size-3.5" />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" onClick={discard} aria-label="Discard voice input" title="Discard voice input">
            <X className="size-3.5" />
          </Button>
        </>
      ) : null}
      {state === "ready" ? <span className="text-[10px] text-emerald-500">Draft inserted</span> : null}
      {state === "error" ? (
        <>
          <span className="max-w-40 truncate text-[10px] text-destructive" title={error}>{error}</span>
          {lastRecording ? <Button type="button" size="icon-xs" variant="ghost" onClick={() => void transcribe(lastRecording.blob, lastRecording.duration)} aria-label="Retry transcription"><RotateCcw className="size-3.5" /></Button> : null}
          <Button type="button" size="icon-xs" variant="ghost" onClick={discard} aria-label="Discard recording"><X className="size-3.5" /></Button>
        </>
      ) : null}
    </div>
  );
}
