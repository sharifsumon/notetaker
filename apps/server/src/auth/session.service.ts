import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions, users, type User } from "../db/schema";
import { randomToken, sha256Hex } from "../lib/crypto";

export interface SessionContext {
  sessionId: string;
  csrfToken: string;
  user: User;
}

/**
 * Server-side sessions (BRD 12): the cookie holds a random token; only its SHA-256 hash
 * is stored, so a database leak does not yield usable sessions. Sessions have absolute
 * and idle expiry and can be revoked individually or all at once.
 */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly ttlHours: number,
    private readonly idleHours: number,
  ) {}

  async create(userId: string, userAgent: string | undefined): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + this.ttlHours * 3_600_000);
    await this.db.asSystem((tx) =>
      tx.insert(sessions).values({
        userId,
        tokenHash: sha256Hex(token),
        csrfToken,
        userAgent: userAgent?.slice(0, 300) ?? null,
        expiresAt,
      }),
    );
    return { token, csrfToken, expiresAt };
  }

  async resolve(token: string): Promise<SessionContext | null> {
    if (!token || token.length > 200) return null;
    const now = new Date();
    return this.db.asSystem(async (tx) => {
      const [row] = await tx
        .select({ s: sessions, u: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, sha256Hex(token)),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
            isNull(users.deletedAt),
          ),
        );
      if (!row) return null;
      if (now.getTime() - row.s.lastSeenAt.getTime() > this.idleHours * 3_600_000) {
        await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, row.s.id));
        return null;
      }
      if (now.getTime() - row.s.lastSeenAt.getTime() > 60_000) {
        await tx.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.s.id));
      }
      return { sessionId: row.s.id, csrfToken: row.s.csrfToken, user: row.u };
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.asSystem((tx) => tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId)));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.asSystem((tx) =>
      tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))),
    );
  }
}
