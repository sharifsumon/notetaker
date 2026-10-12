import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertSafeKey, type ByteRange, type StorageAdapter } from "./types";

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  sse: "AES256" | "aws:kms";
  kmsKeyId?: string;
}

/**
 * Private S3-compatible object storage (AWS S3, MinIO, R2...). The bucket must block all
 * public access; objects are encrypted with SSE. Playback uses short-lived presigned URLs
 * issued only after an ownership check, and those URLs are never logged.
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly name = "s3" as const;
  readonly supportsSignedUrls = true;
  private readonly client: S3Client;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
    });
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<{ sizeBytes: number }> {
    assertSafeKey(key);
    // Multipart upload with automatic part retries (resumable at part granularity).
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.opts.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: contentType,
        ServerSideEncryption: this.opts.sse,
        ...(this.opts.sse === "aws:kms" && this.opts.kmsKeyId ? { SSEKMSKeyId: this.opts.kmsKeyId } : {}),
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    });
    await upload.done();
    return { sizeBytes: (await stat(filePath)).size };
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    assertSafeKey(key);
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return { sizeBytes: Number(r.ContentLength ?? 0) };
    } catch {
      return null;
    }
  }

  async openRead(key: string, range?: ByteRange): Promise<Readable> {
    assertSafeKey(key);
    const r = await this.client.send(
      new GetObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    return r.Body as Readable;
  }

  async signedUrl(
    key: string,
    opts: { expiresInSeconds: number; contentType: string; downloadFilename?: string },
  ): Promise<string> {
    assertSafeKey(key);
    const cmd = new GetObjectCommand({
      Bucket: this.opts.bucket,
      Key: key,
      ResponseContentType: opts.contentType,
      ResponseCacheControl: "private, no-store",
      ResponseContentDisposition: opts.downloadFilename
        ? `attachment; filename="${opts.downloadFilename}"`
        : "inline",
    });
    return getSignedUrl(this.client, cmd, { expiresIn: opts.expiresInSeconds });
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }
}
