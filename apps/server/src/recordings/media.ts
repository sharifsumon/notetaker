import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds: number | null;
  hasAudio: boolean;
  formatName: string | null;
}

/** Media tooling (ffprobe/ffmpeg). Arguments are passed as arrays; no shell is involved. */
export class MediaTools {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  async probe(file: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        this.ffprobePath,
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      ));
    } catch {
      return { durationSeconds: null, hasAudio: false, formatName: null };
    }
    const info = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string };
      streams?: Array<{ codec_type?: string; duration?: string }>;
    };
    const audio = (info.streams ?? []).find((s) => s.codec_type === "audio");
    const dur = Number(info.format?.duration ?? audio?.duration);
    return {
      durationSeconds: Number.isFinite(dur) ? dur : null,
      hasAudio: !!audio,
      formatName: info.format?.format_name ?? null,
    };
  }

  /**
   * Normalizes to mono AAC/M4A (audio-only MVP; video streams are dropped). 16 kHz mono
   * is ideal for speech-to-text and plays in all browsers.
   */
  async normalizeToM4a(input: string, output: string, maxDurationSeconds: number): Promise<void> {
    await execFileAsync(
      this.ffmpegPath,
      [
        "-y",
        "-v",
        "error",
        "-i",
        input,
        "-vn",
        "-t",
        String(maxDurationSeconds),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "aac",
        "-b:a",
        "48k",
        "-movflags",
        "+faststart",
        output,
      ],
      { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
  }
}
