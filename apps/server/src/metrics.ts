import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpDuration: new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration",
      labelNames: ["method", "route", "status"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [registry],
    }),
    jobsProcessed: new Counter({
      name: "jobs_processed_total",
      help: "Background jobs processed",
      labelNames: ["type", "outcome"],
      registers: [registry],
    }),
    jobDuration: new Histogram({
      name: "job_duration_seconds",
      help: "Background job duration",
      labelNames: ["type"],
      buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
      registers: [registry],
    }),
    webhookVerificationFailures: new Counter({
      name: "webhook_verification_failures_total",
      help: "Rejected webhook deliveries (bad signature, stale, malformed)",
      labelNames: ["provider", "reason"],
      registers: [registry],
    }),
    botJoinFailures: new Counter({
      name: "bot_join_failures_total",
      help: "Meeting bot join/recording failures reported by the provider",
      labelNames: ["provider", "code"],
      registers: [registry],
    }),
    aiFailures: new Counter({
      name: "ai_generation_failures_total",
      help: "Summary/minutes generation failures",
      labelNames: ["type", "code"],
      registers: [registry],
    }),
    jobQueueDepth: new Gauge({
      name: "jobs_pending",
      help: "Durable jobs awaiting execution by status",
      labelNames: ["status"],
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
