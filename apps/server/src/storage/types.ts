import type { Readable } from "node:stream";

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/**
 * Private object storage abstraction (FR-05). Business logic never sees paths/URLs of
 * the underlying store; keys are always generated server-side.
 */
export interface StorageAdapter {
  readonly name: "local" | "s3";
  /** Whether playback should redirect to a short-lived signed URL instead of proxying bytes. */
  readonly supportsSignedUrls: boolean;
  putFile(key: string, filePath: string, contentType: string): Promise<{ sizeBytes: number }>;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  openRead(key: string, range?: ByteRange): Promise<Readable>;
  signedUrl(key: string, opts: { expiresInSeconds: number; contentType: string; downloadFilename?: string }): Promise<string>;
  delete(key: string): Promise<void>;
  healthCheck(): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,500}$/;

/** Rejects anything that is not a server-generated key (no traversal, no user filenames). */
export function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error("Unsafe storage key");
  }
}

export function recordingKey(userId: string, meetingId: string, objectId: string, ext: string): string {
  return `recordings/${userId}/${meetingId}/${objectId}.${ext}`;
}
