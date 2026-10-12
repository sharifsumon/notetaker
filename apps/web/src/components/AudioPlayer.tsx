import { Download, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatClock } from "../lib/format";

/**
 * Accessible audio player (FR-08): play/pause, seek (slider is keyboard-operable),
 * elapsed/total time and download. Media URLs are same-origin API routes that are
 * authorized on every request.
 */
export function AudioPlayer({
  src,
  downloadUrl,
  knownDuration,
  title,
}: {
  src: string;
  downloadUrl: string;
  knownDuration: number | null;
  title: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number>(knownDuration ?? 0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onTime = () => setTime(a.currentTime);
    const onMeta = () => Number.isFinite(a.duration) && setDuration(a.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError(true);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onPause);
    a.addEventListener("error", onError);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onPause);
      a.removeEventListener("error", onError);
    };
  }, []);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setError(true));
    else a.pause();
  };

  return (
    <div>
      <audio ref={audio} src={src} preload="metadata" />
      <div className="player">
        <button
          type="button"
          className="btn btn-primary"
          onClick={toggle}
          aria-label={playing ? `Pause recording of ${title}` : `Play recording of ${title}`}
        >
          {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={1}
          value={Math.min(time, duration || 0)}
          onChange={(e) => {
            if (audio.current) audio.current.currentTime = Number(e.target.value);
            setTime(Number(e.target.value));
          }}
          aria-label="Seek"
          aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
          disabled={!duration}
        />
        <span className="time" aria-live="off">
          {formatClock(time)} / {duration ? formatClock(duration) : "–:––"}
        </span>
      </div>
      <div className="player-actions">
        <a className="btn btn-sm" href={downloadUrl} download>
          <Download size={16} aria-hidden="true" />
          Download audio
        </a>
      </div>
      {error && (
        <p className="small" role="alert" style={{ color: "var(--bad)", marginTop: "0.5rem" }}>
          The recording couldn't be played. Your session may have expired, or the file is
          unavailable. Reload the page and try again, or download the file instead.
        </p>
      )}
    </div>
  );
}
