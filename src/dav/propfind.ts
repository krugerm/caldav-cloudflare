import { canSeeCollection } from "../auth/scope";
import { HttpError, pre } from "../http/errors";
import { readXml } from "../http/body";
import { xmlResponse } from "../http/response";
import { listCollections } from "../store/collections";
import { listObjects } from "../store/objects";
import type { DavContext, Resource } from "./context";
import { multistatus, propResponse, propstats } from "./multistatus";
import { allPropKeys, resourceHref } from "./props";
import { NS, child, clark, d, type XmlElement } from "./xml";

/**
 * Depth for PROPFIND. An explicit infinity is refused as RFC 4918 §9.1
 * allows; a missing header, which the RFC also reads as infinity, is
 * treated as 1 because some discovery requests omit it (D-006, D-023).
 */
export function depthOf(request: Request): 0 | 1 {
  const h = request.headers.get("Depth")?.trim().toLowerCase();
  if (h === "0") return 0;
  if (h === "infinity") throw new HttpError(403, "Depth: infinity is not supported", pre.dav("propfind-finite-depth"));
  return 1;
}

/** Child resources for Depth: 1. */
export async function childrenOf(ctx: DavContext, r: Resource): Promise<Resource[]> {
  switch (r.kind) {
    case "root":
      return [{ kind: "principals" }];
    case "principals":
      return [{ kind: "principal", user: ctx.principal.username }];
    case "home": {
      const colls = await listCollections(ctx.env.DB, ctx.principal.userId);
      return colls
        .filter((coll) => canSeeCollection(ctx.principal.scope, coll.slug))
        .map((coll) => ({ kind: "collection" as const, user: r.user, coll }));
    }
    case "collection": {
      const objs = await listObjects(ctx.env.DB, r.coll.id);
      return objs.map((obj) => ({ kind: "object" as const, user: r.user, coll: r.coll, obj }));
    }
    default:
      return [];
  }
}

type Request_ = { mode: "prop"; keys: string[] } | { mode: "allprop"; include: string[] } | { mode: "propname" };

/** The property keys listed in a <prop> element. */
export const propKeys = (prop: XmlElement | undefined) => (prop?.children ?? []).map((p) => clark(p.ns, p.name));

function parsePropfind(body: XmlElement | null): Request_ {
  if (!body) return { mode: "allprop", include: [] };
  if (body.ns !== NS.DAV || body.name !== "propfind") throw new HttpError(400, "expected DAV:propfind");
  const modes = ["prop", "propname", "allprop"].filter((m) => child(body, NS.DAV, m));
  if (modes.length > 1) throw new HttpError(400, "propfind takes one of prop, allprop or propname");
  const prop = child(body, NS.DAV, "prop");
  if (prop) return { mode: "prop", keys: propKeys(prop) };
  if (child(body, NS.DAV, "propname")) return { mode: "propname" };
  if (child(body, NS.DAV, "allprop")) return { mode: "allprop", include: propKeys(child(body, NS.DAV, "include")) };
  throw new HttpError(400, "propfind needs prop, allprop or propname");
}

export async function propfind(ctx: DavContext, target: Resource): Promise<Response> {
  const req = parsePropfind(await readXml(ctx.request));
  const resources = depthOf(ctx.request) === 1 ? [target, ...(await childrenOf(ctx, target))] : [target];
  const responses = await Promise.all(
    resources.map(async (r) => {
      const h = resourceHref(r);
      if (req.mode === "propname") {
        return d("response", [d("href", h), ...propstats(allPropKeys(r, true).map((key) => ({ key, value: [] })))]);
      }
      const keys = req.mode === "prop" ? req.keys : [...new Set([...allPropKeys(r), ...req.include])];
      return propResponse(ctx, h, r, keys);
    }),
  );
  return xmlResponse(multistatus(responses));
}
