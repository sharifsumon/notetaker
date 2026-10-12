/**
 * Grants or revokes the admin (operations) role. Admin access is intentionally not
 * bootstrapped from email addresses. Usage: pnpm admin:grant <userId> [--revoke]
 */
import { eq } from "drizzle-orm";
import { Db } from "../db/client";
import { auditEvents, users } from "../db/schema";

const [userId, flag] = process.argv.slice(2);
if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
  console.error("Usage: grant-admin <userId> [--revoke]");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}
const db = new Db(url, 1);
const role = flag === "--revoke" ? "user" : "admin";
const updated = await db.asSystem(async (tx) => {
  const r = await tx.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId)).returning({ id: users.id });
  if (r.length) {
    await tx.insert(auditEvents).values({ actorType: "system", actorId: "cli", action: `admin.role_${role === "admin" ? "granted" : "revoked"}`, targetType: "user", targetId: userId });
  }
  return r.length;
});
await db.close();
console.log(updated ? `User ${userId} role set to ${role}` : "User not found");
process.exit(updated ? 0 : 1);
