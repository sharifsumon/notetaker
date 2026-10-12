import express, { Router, type RequestHandler } from "express";
import { z } from "zod";
import { WebhookVerificationError } from "../bot/types";
import type { Container } from "../container";
import { Errors } from "../lib/errors";
import { route } from "../lib/http";

/**
 * Meeting-provider webhook receiver (FR-04). Payloads are untrusted until the provider
 * adapter verifies signature + timestamp. Duplicates/replays are absorbed by the inbox.
 */
export function webhookRoutes(c: Container, webhookLimiter: RequestHandler): Router {
  const r = Router();
  route(
    r,
    {
      method: "post",
      path: "/webhooks/meeting-provider/:provider",
      summary: "Signed meeting-bot provider webhook",
      tag: "Webhooks",
      auth: "webhook",
      params: z.object({ provider: z.string().regex(/^[a-z0-9_-]{1,40}$/) }),
      middleware: [webhookLimiter, express.raw({ type: "*/*", limit: "256kb" })],
      responses: { 200: { description: "Accepted" }, 401: { description: "Verification failed" } },
    },
    async (req, res, { params }) => {
      const provider = c.bot;
      if (!provider || provider.name !== params.provider) throw Errors.notFound("Webhook");
      const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers))
        headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      let events;
      try {
        events = provider.verifyAndParseWebhook(raw, headers, new Date());
      } catch (err) {
        const reason = err instanceof WebhookVerificationError ? err.reason : "malformed";
        c.metrics.webhookVerificationFailures.inc({ provider: provider.name, reason });
        req.log.warn({ provider: provider.name, reason }, "webhook rejected");
        res.status(401).json({
          error: {
            code: "webhook_verification_failed",
            message: "Webhook verification failed",
            requestId: req.requestId,
          },
        });
        return;
      }
      const outcomes = [];
      for (const ev of events) outcomes.push(await c.botService.applyEvent(provider.name, ev));
      res.status(200).json({ received: events.length, outcomes });
    },
  );
  return r;
}
