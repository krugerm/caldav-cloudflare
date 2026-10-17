import { serialize, type XNode } from "../dav/xml";

export function xmlResponse(root: XNode, status = 207, headers: Record<string, string> = {}): Response {
  return new Response(serialize(root), {
    status,
    headers: { "Content-Type": "application/xml; charset=utf-8", ...headers },
  });
}

export const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });
