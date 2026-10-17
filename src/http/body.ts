import { parseXml, XmlParseError, type XmlElement } from "../dav/xml";
import { HttpError } from "./errors";

const MAX_XML_BYTES = 1024 * 1024;

/** Read a request body with a size cap. Rejects early on Content-Length, then while streaming. */
export async function readBytes(request: Request, max: number, tooLarge: () => HttpError): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

/** Parse an XML request body; null when the body is empty. */
export async function readXml(request: Request): Promise<XmlElement | null> {
  const bytes = await readBytes(request, MAX_XML_BYTES, () => new HttpError(413, "request body too large"));
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return null;
  try {
    return parseXml(text);
  } catch (e) {
    if (e instanceof XmlParseError) throw new HttpError(400, `malformed XML: ${e.message}`);
    throw e;
  }
}
