import { ensureBootstrapAdmin } from "./auth/auth";
import { handleDav } from "./dav/handler";
import type { AppEnv } from "./env";
import { HttpError } from "./http/errors";
import { runScheduled } from "./cron";
import { handleAdmin } from "./admin/routes";

export async function handle(request: Request, env: AppEnv, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p.catch((e) => console.error("background task failed", e)));
  try {
    await ensureBootstrapAdmin(env);
    const { pathname } = new URL(request.url);
    if (pathname === "/.well-known/caldav" || pathname === "/.well-known/caldav/") {
      return new Response(null, { status: 301, headers: { Location: "/dav/" } });
    }
    if (pathname === "/dav" || pathname.startsWith("/dav/")) return await handleDav(request, env, waitUntil);
    if (pathname === "/admin" || pathname.startsWith("/admin/")) return await handleAdmin(request, env);
    // some clients PROPFIND or OPTIONS the host root during discovery; answer as the DAV root
    if (pathname === "/" && request.method !== "GET" && request.method !== "HEAD") return await handleDav(request, env, waitUntil);
    if (pathname === "/") {
      return new Response("CalDAV server. Point your client at this host; the admin page is at /admin.\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    throw new HttpError(404, "not found");
  } catch (e) {
    if (e instanceof HttpError) return e.toResponse();
    console.error("unhandled error", e);
    return new Response("internal error\n", { status: 500 });
  }
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled: (controller, env, ctx) => ctx.waitUntil(runScheduled(controller.cron, env, controller.scheduledTime)),
} satisfies ExportedHandler<AppEnv>;
