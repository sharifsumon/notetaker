import type { Tx } from "../db/client";
import { auditEvents } from "../db/schema";
import type { Logger } from "../lib/logger";

export interface AuditEntry {
  actorType: "user" | "admin" | "system" | "provider";
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  correlationId?: string | null;
  /** Safe metadata only: never tokens, audio, transcript text or signed URLs. */
  metadata?: Record<string, unknown>;
}

const FORBIDDEN_KEYS = /(token|secret|password|url|cookie)$|^(transcript|transcripttext|content|text|body)$/i;

function scrub(meta: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!meta) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    if (typeof v === "string" && v.length > 200) continue;
    out[k] = v;
  }
  return out;
}

export class AuditService {
  constructor(private readonly logger: Logger) {}

  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    await tx.insert(auditEvents).values({
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      correlationId: entry.correlationId ?? null,
      metadata: scrub(entry.metadata),
    });
    this.logger.info(
      { audit: { action: entry.action, actorType: entry.actorType, targetType: entry.targetType, targetId: entry.targetId } },
      "audit",
    );
  }
}
