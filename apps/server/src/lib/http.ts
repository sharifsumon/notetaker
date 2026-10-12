import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z, type ZodType } from "zod";
import { Errors } from "./errors";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface RouteDef<P extends ZodType, Q extends ZodType, B extends ZodType> {
  method: HttpMethod;
  /** Express path relative to /api/v1, e.g. `/meetings/:meetingId`. */
  path: string;
  summary: string;
  tag: string;
  auth: "public" | "user" | "admin" | "webhook";
  params?: P;
  query?: Q;
  body?: B;
  responses?: Record<number, { description: string; schema?: ZodType; contentType?: string }>;
  middleware?: RequestHandler[];
}

export interface RegisteredRoute {
  method: HttpMethod;
  path: string;
  summary: string;
  tag: string;
  auth: string;
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  responses?: Record<number, { description: string; schema?: ZodType; contentType?: string }>;
}

/** Global registry used to produce the OpenAPI document. */
export const routeRegistry: RegisteredRoute[] = [];

export interface Validated<P, Q, B> {
  params: P;
  query: Q;
  body: B;
}

function parse<T>(schema: ZodType<T> | undefined, value: unknown): T {
  if (!schema) return undefined as T;
  const r = schema.safeParse(value);
  if (!r.success) {
    if (r.error.issues.some((i) => i.message === "not_found")) throw Errors.notFound();
    throw Errors.validation(
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })),
    );
  }
  return r.data;
}

/**
 * Registers a route with schema validation of params/query/body (BRD 8.3) and records
 * it for the OpenAPI spec. Handlers receive already-validated input.
 */
export function route<P extends ZodType = ZodType, Q extends ZodType = ZodType, B extends ZodType = ZodType>(
  router: Router,
  def: RouteDef<P, Q, B>,
  handler: (
    req: Request,
    res: Response,
    input: Validated<z.infer<P>, z.infer<Q>, z.infer<B>>,
  ) => Promise<unknown> | unknown,
): void {
  routeRegistry.push({
    method: def.method,
    path: def.path,
    summary: def.summary,
    tag: def.tag,
    auth: def.auth,
    params: def.params,
    query: def.query,
    body: def.body,
    responses: def.responses,
  });
  const wrapped = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = {
        params: parse(def.params, req.params),
        query: parse(def.query, req.query),
        body: parse(def.body, def.body ? (req.body ?? {}) : undefined),
      } as Validated<z.infer<P>, z.infer<Q>, z.infer<B>>;
      const result = await handler(req, res, input);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (err) {
      next(err);
    }
  };
  router[def.method](def.path, ...(def.middleware ?? []), wrapped);
}

export const UuidParam = (name: string) => z.object({ [name]: z.uuid() });

/** Path params that must be UUIDs. Malformed ids return 404 (no shape probing). */
export function uuidParams<K extends string>(...names: K[]) {
  const shape = Object.fromEntries(names.map((n) => [n, z.string()])) as Record<K, z.ZodString>;
  return z.object(shape).superRefine((v, ctx) => {
    for (const n of names) {
      if (!z.uuid().safeParse((v as Record<string, string>)[n]).success) {
        ctx.addIssue({ code: "custom", message: "not_found", path: [n] });
      }
    }
  });
}
