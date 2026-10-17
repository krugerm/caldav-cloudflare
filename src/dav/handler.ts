import { authenticate } from "../auth/auth";
import { config, type AppEnv } from "../env";
import { HttpError } from "../http/errors";
import { empty } from "../http/response";
import type { DavContext, Resource } from "./context";
import { BadPath, parsePath, type Address } from "./paths";
import { deleteCollection, makeCollection, proppatch } from "./collection";
import { move } from "./move";
import { deleteObject, getObjectResource, putObject } from "./object";
import { propfind } from "./propfind";
import { report } from "./report";
import { resolve, notFound } from "./resolve";

// No MKCALENDAR: workerd rejects that method before the Worker sees it (D-010).
export const ALLOW = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCOL, MOVE";
// No calendar-auto-schedule: scheduling (RFC 6638) is out of scope, and clients read its absence.
export const DAV_HEADER = "1, 3, calendar-access, extended-mkcol";

type Handler = (ctx: DavContext, address: Address, target: Resource | null) => Promise<Response>;

const existing =
  (fn: (ctx: DavContext, target: Resource, address: Address) => Promise<Response>): Handler =>
  (ctx, address, target) => {
    if (!target) throw notFound();
    return fn(ctx, target, address);
  };

const routes: Record<string, Handler> = {
  PROPFIND: existing((ctx, target) => propfind(ctx, target)),
  PROPPATCH: existing((ctx, target) => proppatch(ctx, target)),
  MKCOL: makeCollection,
  DELETE: existing((ctx, target) => {
    if (target.kind === "collection") return deleteCollection(ctx, target);
    if (target.kind === "object") return deleteObject(ctx, target);
    throw new HttpError(403, "this resource cannot be deleted");
  }),
  GET: existing((ctx, target) => getObjectResource(ctx, target, false)),
  HEAD: existing((ctx, target) => getObjectResource(ctx, target, true)),
  PUT: putObject,
  REPORT: existing((ctx, target) => report(ctx, target)),
  MOVE: existing((ctx, target) => move(ctx, target)),
};

export async function handleDav(request: Request, env: AppEnv, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  let address: Address | null;
  try {
    address = parsePath(url.pathname);
  } catch (e) {
    if (e instanceof BadPath) throw new HttpError(400, e.message);
    throw e;
  }
  if (request.method === "OPTIONS") {
    // unauthenticated, so clients can discover capabilities before logging in
    return empty(200, { Allow: ALLOW, DAV: DAV_HEADER, "Content-Length": "0" });
  }
  const { principal, touch } = await authenticate(env, request);
  if (touch) waitUntil(touch);
  if (!address) throw notFound();
  const handler = routes[request.method];
  if (!handler) throw new HttpError(405, "method not allowed", undefined, { Allow: ALLOW });
  const ctx: DavContext = { env, cfg: config(env), request, url, principal, waitUntil };
  return handler(ctx, address, await resolve(ctx, address));
}
