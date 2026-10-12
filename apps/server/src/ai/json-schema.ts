import { z, type ZodType } from "zod";

const UNSUPPORTED = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "default",
  "pattern",
]);

type Json = Record<string, unknown>;

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (UNSUPPORTED.has(k)) continue;
    if (k === "minItems" && typeof v === "number" && v > 1) continue;
    out[k] = sanitize(v);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Json);
  }
  return out;
}

/**
 * Converts a Zod schema to the JSON Schema subset accepted by structured-output APIs:
 * every object is closed (`additionalProperties: false`) with all properties required;
 * length/count constraints are dropped (they are still enforced by Zod on the response).
 */
export function toStructuredOutputSchema(schema: ZodType): Json {
  return sanitize(z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" })) as Json;
}
