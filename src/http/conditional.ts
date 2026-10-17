// If-Match / If-None-Match evaluation (RFC 9110 §13.1).

const parseList = (h: string) => h.split(",").map((s) => s.trim()).filter(Boolean);
const opaque = (tag: string) => tag.replace(/^W\//, "");

export interface Preconditions {
  ifMatch: string | null;
  ifNoneMatch: string | null;
}

export const preconditionsOf = (request: Request): Preconditions => ({
  ifMatch: request.headers.get("If-Match"),
  ifNoneMatch: request.headers.get("If-None-Match"),
});

export const hasPreconditions = (p: Preconditions) => p.ifMatch !== null || p.ifNoneMatch !== null;

/** If-Match uses strong comparison; a weak tag never matches. */
export function ifMatchHolds(header: string, current: string | null): boolean {
  if (current === null) return false;
  const tags = parseList(header);
  return tags.includes("*") || tags.some((t) => !t.startsWith("W/") && t === current);
}

/** If-None-Match uses weak comparison. */
export function ifNoneMatchHolds(header: string, current: string | null): boolean {
  if (current === null) return true;
  const tags = parseList(header);
  return !(tags.includes("*") || tags.some((t) => opaque(t) === opaque(current)));
}

/** True when the request's preconditions allow a state-changing method to proceed. */
export function writePreconditionsHold(p: Preconditions, currentEtag: string | null): boolean {
  if (p.ifMatch !== null && !ifMatchHolds(p.ifMatch, currentEtag)) return false;
  if (p.ifNoneMatch !== null && !ifNoneMatchHolds(p.ifNoneMatch, currentEtag)) return false;
  return true;
}
