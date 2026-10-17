import { getProp, type PropResult, type PropValue } from "./props";
import type { DavContext, Resource } from "./context";
import { NS, d, parseClark, type XNode } from "./xml";

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  412: "Precondition Failed",
  424: "Failed Dependency",
  507: "Insufficient Storage",
};

export const statusLine = (code: number) => `HTTP/1.1 ${code} ${STATUS_TEXT[code] ?? ""}`.trimEnd();

/** The <prop> child for one property: its value, or an empty element when reporting a name or status only. */
export function propNode(key: string, value?: PropValue | XNode): XNode {
  const { ns, name } = parseClark(key);
  if (value === undefined) return { ns, name };
  if (typeof value === "string") return { ns, name, text: value };
  if (Array.isArray(value)) return { ns, name, children: value };
  // a dead property: the stored fragment is the whole property element
  return value.raw !== undefined ? value : { ns, name, children: [value] };
}

/** Group property results into propstat elements: found (200) and missing (404). */
export function propstats(results: PropResult[]): XNode[] {
  const found = results.filter((r): r is Extract<PropResult, { value: unknown }> => "value" in r);
  const missing = results.filter((r) => "missing" in r);
  const out: XNode[] = [];
  if (found.length) out.push(d("propstat", [d("prop", found.map((r) => propNode(r.key, r.value))), d("status", statusLine(200))]));
  if (missing.length) out.push(d("propstat", [d("prop", missing.map((r) => propNode(r.key))), d("status", statusLine(404))]));
  // RFC 4918 §14.24: a response carries a status or at least one propstat, even when no properties were asked for
  if (out.length === 0) out.push(d("propstat", [d("prop"), d("status", statusLine(200))]));
  return out;
}

export async function propResponse(ctx: DavContext, href: string, r: Resource, keys: string[], extra: PropResult[] = []): Promise<XNode> {
  const results = [...(await Promise.all(keys.map((k) => getProp(ctx, r, k)))), ...extra];
  return d("response", [d("href", href), ...propstats(results)]);
}

export const statusResponse = (href: string, code: number) => d("response", [d("href", href), d("status", statusLine(code))]);

export const multistatus = (responses: XNode[], extra: XNode[] = []) => ({ ns: NS.DAV, name: "multistatus", children: [...responses, ...extra] });
