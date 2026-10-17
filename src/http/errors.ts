import { NS, el, serialize, type XNode } from "../dav/xml";

/** An error that maps to an HTTP response, optionally with a DAV:error precondition body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message = "",
    readonly precondition?: XNode,
    readonly headers: Record<string, string> = {},
  ) {
    super(message || String(status));
  }

  toResponse(): Response {
    const headers = new Headers(this.headers);
    if (this.precondition) {
      headers.set("Content-Type", "application/xml; charset=utf-8");
      return new Response(serialize(el(NS.DAV, "error", [this.precondition])), { status: this.status, headers });
    }
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(this.message + "\n", { status: this.status, headers });
  }
}

/** Precondition element shorthands. */
export const pre = {
  dav: (name: string, children?: XNode[]) => el(NS.DAV, name, children),
  caldav: (name: string, children?: XNode[]) => el(NS.CALDAV, name, children),
};
