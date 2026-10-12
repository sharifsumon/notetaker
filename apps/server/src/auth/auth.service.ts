import { and, eq } from "drizzle-orm";
import type { AuditService } from "../audit/audit.service";
import type { Db } from "../db/client";
import { authIdentities, users, type User } from "../db/schema";
import { Errors } from "../lib/errors";
import type { VerifiedIdentity } from "./oauth";

export type AuthProvider = "google" | "microsoft" | "dev";

/**
 * Account resolution policy (BRD 9 "account linking"):
 * - An identity is keyed by (provider, provider subject). Emails are never used to merge.
 * - A new identity creates a new account, unless the user is already signed in and is
 *   explicitly linking another provider to their account.
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly defaultTimezone: string,
  ) {}

  async resolveUser(
    provider: AuthProvider,
    identity: VerifiedIdentity,
    opts: { linkToUserId?: string; correlationId?: string },
  ): Promise<User> {
    return this.db.asSystem(async (tx) => {
      const [existing] = await tx
        .select({ u: users })
        .from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .where(
          and(
            eq(authIdentities.provider, provider),
            eq(authIdentities.providerSubject, identity.subject),
          ),
        );

      if (existing) {
        if (existing.u.deletedAt) throw Errors.forbidden("This account has been deleted");
        if (opts.linkToUserId && existing.u.id !== opts.linkToUserId) {
          throw Errors.conflict(
            "identity_already_linked",
            "This sign-in is already linked to a different account",
          );
        }
        await tx
          .update(authIdentities)
          .set({
            emailAtProvider: identity.email,
            emailVerified: identity.emailVerified,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(authIdentities.provider, provider),
              eq(authIdentities.providerSubject, identity.subject),
            ),
          );
        await this.audit.record(tx, {
          actorType: "user",
          actorId: existing.u.id,
          action: "auth.sign_in",
          targetType: "user",
          targetId: existing.u.id,
          correlationId: opts.correlationId,
          metadata: { provider },
        });
        return existing.u;
      }

      let user: User;
      if (opts.linkToUserId) {
        const [u] = await tx.select().from(users).where(eq(users.id, opts.linkToUserId));
        if (!u) throw Errors.unauthenticated();
        user = u;
      } else {
        const email = identity.email?.trim().toLowerCase() ?? null;
        const [u] = await tx
          .insert(users)
          .values({
            email,
            emailVerified: identity.emailVerified,
            displayName: (identity.name ?? email ?? "User").slice(0, 120),
            timezone: this.defaultTimezone,
          })
          .returning();
        user = u!;
      }
      await tx.insert(authIdentities).values({
        userId: user.id,
        provider,
        providerSubject: identity.subject,
        providerTenant: identity.tenant,
        emailAtProvider: identity.email,
        emailVerified: identity.emailVerified,
      });
      await this.audit.record(tx, {
        actorType: "user",
        actorId: user.id,
        action: opts.linkToUserId ? "auth.identity_linked" : "auth.account_created",
        targetType: "user",
        targetId: user.id,
        correlationId: opts.correlationId,
        metadata: { provider },
      });
      return user;
    });
  }
}
