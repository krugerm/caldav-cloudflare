// URL layout:
//   /dav/                                     root
//   /dav/principals/                          principal collection
//   /dav/principals/<user>/                   principal
//   /dav/calendars/<user>/                    calendar home
//   /dav/calendars/<user>/<collection>/       calendar collection
//   /dav/calendars/<user>/<collection>/<obj>  calendar object resource

export const DAV_ROOT = "/dav/";

export type Address =
  | { kind: "root" }
  | { kind: "principals" }
  | { kind: "principal"; user: string }
  | { kind: "home"; user: string }
  | { kind: "collection"; user: string; collection: string }
  | { kind: "object"; user: string; collection: string; object: string };

export class BadPath extends Error {}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new BadPath("bad percent-encoding");
  }
}

/** Parse a request path; null when it is outside /dav/ or doesn't match the layout. */
export function parsePath(pathname: string): Address | null {
  if (pathname === "/dav" || pathname === "/") return { kind: "root" };
  if (!pathname.startsWith(DAV_ROOT)) return null;
  const trailing = pathname.endsWith("/");
  const segs = pathname.slice(DAV_ROOT.length).split("/").filter((s) => s !== "").map(decodeSegment);
  if (segs.some((s) => s === "." || s === ".." || s.includes("/"))) throw new BadPath("bad segment");
  const [area, user, collection, object, ...rest] = segs;
  if (rest.length > 0) return null;
  if (area === undefined) return { kind: "root" };
  if (area === "principals") {
    if (user === undefined) return { kind: "principals" };
    return collection === undefined ? { kind: "principal", user } : null;
  }
  if (area !== "calendars" || user === undefined) return null;
  if (collection === undefined) return { kind: "home", user };
  if (object === undefined) return { kind: "collection", user, collection };
  return trailing ? null : { kind: "object", user, collection, object };
}

/**
 * Percent-encode a path segment, leaving the characters RFC 3986 allows in a
 * segment (pchar) as they are, so a client that PUT "abc@host.ics" sees the
 * same name back in every href.
 */
const enc = (s: string) =>
  encodeURIComponent(s).replace(/%(40|3A|2B|21|24|26|27|28|29|2A|2C|3B|3D)/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

export const href = {
  root: () => DAV_ROOT,
  principals: () => `${DAV_ROOT}principals/`,
  principal: (user: string) => `${DAV_ROOT}principals/${enc(user)}/`,
  home: (user: string) => `${DAV_ROOT}calendars/${enc(user)}/`,
  collection: (user: string, slug: string) => `${DAV_ROOT}calendars/${enc(user)}/${enc(slug)}/`,
  object: (user: string, slug: string, name: string) => `${DAV_ROOT}calendars/${enc(user)}/${enc(slug)}/${enc(name)}`,
};

export function hrefOf(a: Address): string {
  switch (a.kind) {
    case "root":
      return href.root();
    case "principals":
      return href.principals();
    case "principal":
      return href.principal(a.user);
    case "home":
      return href.home(a.user);
    case "collection":
      return href.collection(a.user, a.collection);
    case "object":
      return href.object(a.user, a.collection, a.object);
  }
}

/** Resolve an href from a request body (absolute URL or absolute path) to an address. */
export function parseHref(value: string, base: string): Address | null {
  let url: URL;
  try {
    url = new URL(value.trim(), base);
  } catch {
    return null;
  }
  try {
    return parsePath(url.pathname);
  } catch {
    return null;
  }
}

/** Slugs and object names: anything a path segment can hold, within reason. */
export const isValidName = (s: string) => s.length > 0 && s.length <= 255 && !/[\/\x00-\x1f\x7f]/.test(s) && s !== "." && s !== "..";
