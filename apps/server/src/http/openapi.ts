import { ErrorEnvelopeSchema } from "@notetaker/shared";
import { z, type ZodType } from "zod";
import { routeRegistry } from "../lib/http";

function schemaOf(s: ZodType): Record<string, unknown> {
  const j = z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete j.$schema;
  return j;
}

/** Builds the OpenAPI 3.1 document from the routes registered with `route()`. */
export function buildOpenApi(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const r of routeRegistry) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const oasPath = `/api/v1${r.path.replace(/:(\w+)/g, "{$1}")}`;
    const parameters: unknown[] = [];
    for (const [where, schema] of [
      ["path", r.params],
      ["query", r.query],
    ] as const) {
      if (!schema) continue;
      const js = schemaOf(schema) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, prop] of Object.entries(js.properties ?? {})) {
        parameters.push({ name, in: where, required: where === "path" || (js.required ?? []).includes(name), schema: prop });
      }
    }
    const responses: Record<string, unknown> = {};
    for (const [code, resp] of Object.entries(r.responses ?? { 200: { description: "OK" } })) {
      responses[code] = {
        description: resp.description,
        ...(resp.schema
          ? { content: { "application/json": { schema: schemaOf(resp.schema) } } }
          : resp.contentType
            ? { content: { [resp.contentType]: { schema: { type: "string", format: "binary" } } } }
            : {}),
      };
    }
    responses.default = { description: "Error", content: { "application/json": { schema: schemaOf(ErrorEnvelopeSchema) } } };
    paths[oasPath] ??= {};
    paths[oasPath][r.method] = {
      summary: r.summary,
      tags: [r.tag],
      ...(r.auth === "user" || r.auth === "admin" ? { security: [{ sessionCookie: [], csrfHeader: [] }] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: schemaOf(r.body) } } } } : {}),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Meeting Notetaker API",
      version,
      description:
        "Cookie-session API. State-changing requests require the `X-CSRF-Token` header (value from GET /api/v1/me). All errors use the envelope `{ error: { code, message, requestId } }`.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "nt_session" },
        csrfHeader: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
      },
    },
    paths,
  };
}
