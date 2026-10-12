import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { assertSafeKey, type ByteRange, type StorageAdapter } from "./types";

/**
 * Private server-filesystem storage for local development / single-server deployments.
 * Files are never served statically; every read goes through an authorized API route.
 * Encryption at rest is provided by the host volume (see docs/DEPLOYMENT.md).
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly name = "local" as const;
  readonly supportsSignedUrls = false;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Unsafe storage key");
    return full;
  }

  async putFile(key: string, filePath: string): Promise<{ sizeBytes: number }> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.part`;
    await copyFile(filePath, tmp);
    await rename(tmp, dest); // atomic publish: no partially written objects
    return { sizeBytes: (await stat(dest)).size };
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      return { sizeBytes: (await stat(this.resolve(key))).size };
    } catch {
      return null;
    }
  }

  async openRead(key: string, range?: ByteRange): Promise<Readable> {
    const full = this.resolve(key);
    return createReadStream(full, range ? { start: range.start, end: range.end } : {});
  }

  async signedUrl(): Promise<string> {
    throw new Error("Local storage does not issue signed URLs");
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async healthCheck(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const probe = path.join(this.root, ".healthcheck");
    await writeFile(probe, String(Date.now()));
    await rm(probe, { force: true });
  }
}
