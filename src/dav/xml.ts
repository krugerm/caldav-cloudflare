// Namespace-aware XML: parse request bodies, build multistatus responses.
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const NS = {
  DAV: "DAV:",
  CALDAV: "urn:ietf:params:xml:ns:caldav",
  CS: "http://calendarserver.org/ns/",
  APPLE: "http://apple.com/ns/ical/",
} as const;

const KNOWN_PREFIXES: Record<string, string> = {
  [NS.DAV]: "d",
  [NS.CALDAV]: "c",
  [NS.CS]: "cs",
  [NS.APPLE]: "ical",
};

/** A parsed element with its namespace resolved. */
export interface XmlElement {
  ns: string;
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text directly inside this element. */
  text: string;
}

export class XmlParseError extends Error {}

/** `{ns}name`, the Clark notation used as a property key. */
export const clark = (ns: string, name: string) => `{${ns}}${name}`;

export function parseClark(key: string): { ns: string; name: string } {
  const m = /^\{([^}]*)\}(.+)$/.exec(key);
  if (!m) throw new Error(`not a Clark name: ${key}`);
  return { ns: m[1]!, name: m[2]! };
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // entities are decoded by decodeEntities below, in one pass, so "&amp;#13;" stays literal
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  htmlEntities: false,
});

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decode the five predefined entities and numeric character references. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const cp = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED[ref] ?? whole;
  });
}

type RawNode = Record<string, unknown> & { ":@"?: Record<string, string> };

export function parseXml(text: string): XmlElement {
  if (/<!DOCTYPE/i.test(text)) throw new XmlParseError("DOCTYPE not allowed");
  // the parser tolerates unclosed tags, so check well-formedness first
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new XmlParseError(valid.err.msg);
  let raw: RawNode[];
  try {
    raw = parser.parse(text) as RawNode[];
  } catch (e) {
    throw new XmlParseError(String(e));
  }
  const roots = raw.map((n) => convert(n, new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]))).filter(
    (e): e is XmlElement => e !== null,
  );
  if (roots.length !== 1) throw new XmlParseError("expected one root element");
  return roots[0]!;
}

function convert(node: RawNode, scope: Map<string, string>): XmlElement | null {
  const tag = Object.keys(node).find((k) => k !== ":@");
  if (!tag || tag === "#text" || tag.startsWith("?") || tag === "#comment") return null;
  const rawAttrs = node[":@"] ?? {};
  const local = new Map(scope);
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (k === "xmlns") local.set("", v);
    else if (k.startsWith("xmlns:")) local.set(k.slice(6), v);
  }
  const [prefix, name] = tag.includes(":") ? (tag.split(":", 2) as [string, string]) : ["", tag];
  const ns = local.get(prefix);
  if (ns === undefined && prefix !== "") throw new XmlParseError(`undeclared prefix ${prefix}`);
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    // xml:lang and xml:space keep their prefix, which is bound without a declaration, so dead properties round-trip (RFC 4918 §4.3)
    if (k !== "xmlns" && !k.startsWith("xmlns:")) attrs[k.startsWith("xml:") ? k : k.includes(":") ? k.split(":")[1]! : k] = decodeEntities(v);
  }
  const kids = (node[tag] as RawNode[]) ?? [];
  const children: XmlElement[] = [];
  let text = "";
  for (const k of kids) {
    if ("#text" in k) text += decodeEntities(String(k["#text"]));
    else {
      const c = convert(k, local);
      if (c) children.push(c);
    }
  }
  return { ns: ns ?? "", name, attrs, children, text };
}

export function child(el: XmlElement | undefined, ns: string, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.ns === ns && c.name === name);
}

export function children(el: XmlElement | undefined, ns: string, name: string): XmlElement[] {
  return el?.children.filter((c) => c.ns === ns && c.name === name) ?? [];
}

// ---- building ----

/** A node to serialise. `raw` inserts a self-contained XML fragment verbatim. */
export interface XNode {
  ns: string;
  name: string;
  attrs?: Record<string, string>;
  children?: XNode[];
  text?: string;
  raw?: string;
}

export const el = (ns: string, name: string, children?: XNode[] | string): XNode =>
  typeof children === "string" ? { ns, name, text: children } : { ns, name, children };

export const d = (name: string, children?: XNode[] | string) => el(NS.DAV, name, children);
export const c = (name: string, children?: XNode[] | string) => el(NS.CALDAV, name, children);

/** Characters XML 1.0 can't carry, not even as character references. */
export const XML_FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;

/**
 * Escape text and attribute values. CR becomes a character reference because
 * XML parsers normalise raw CRLF to LF; escaped, calendar-data in a REPORT
 * reaches the client with the stored line endings intact.
 */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"\r]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\r": "&#13;" })[ch]!);
}

function collectNamespaces(node: XNode, out: Set<string>) {
  if (node.raw === undefined) out.add(node.ns);
  node.children?.forEach((ch) => collectNamespaces(ch, out));
}

/** Serialise a document, declaring every namespace on the root element. */
export function serialize(root: XNode): string {
  const used = new Set<string>();
  collectNamespaces(root, used);
  const prefixes = new Map<string, string>();
  let n = 0;
  for (const ns of used) prefixes.set(ns, KNOWN_PREFIXES[ns] ?? (ns === "" ? "" : `x${n++}`));
  const decls = [...prefixes]
    .map(([ns, p]) => (p === "" ? ` xmlns="${escapeXml(ns)}"` : ` xmlns:${p}="${escapeXml(ns)}"`))
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n${write(root, prefixes, decls)}`;
}

function write(node: XNode, prefixes: Map<string, string>, decls = ""): string {
  if (node.raw !== undefined) return node.raw;
  const p = prefixes.get(node.ns);
  const tag = p ? `${p}:${node.name}` : node.name;
  const attrs = Object.entries(node.attrs ?? {})
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  const inner =
    (node.text !== undefined ? escapeXml(node.text) : "") +
    (node.children ?? []).map((ch) => write(ch, prefixes)).join("");
  return inner === "" ? `<${tag}${decls}${attrs}/>` : `<${tag}${decls}${attrs}>${inner}</${tag}>`;
}

/** Serialise a parsed element as a self-contained fragment (namespaces declared on it). */
export function serializeFragment(e: XmlElement): string {
  const toNode = (x: XmlElement): XNode => ({
    ns: x.ns,
    name: x.name,
    attrs: x.attrs,
    text: x.text.trim() === "" && x.children.length > 0 ? undefined : x.text || undefined,
    children: x.children.map(toNode),
  });
  return serialize(toNode(e)).replace(/^<\?xml[^>]*>\n/, "");
}
