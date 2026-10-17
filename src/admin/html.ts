// Server-rendered admin page. Every interpolated value goes through esc().
import type { UserView } from "./service";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const when = (s: number | null) => (s === null ? "never" : new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC");

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

const STYLE = `
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --card:#fff; --accent:#2563eb; --danger:#b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --line:#44403c; --card:#292524; --accent:#60a5fa; --danger:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 0; } h3 { font-size: 14px; margin: 16px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.sub { color: var(--muted); margin: 0 0 24px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 16px 0; }
table { width: 100%; border-collapse: collapse; font-size: 14px; } td, th { text-align: left; padding: 6px 8px; border-top: 1px solid var(--line); vertical-align: top; } th { color: var(--muted); font-weight: 500; border-top: 0; }
.scroll { overflow-x: auto; }
form.inline { display: inline; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-top: 10px; }
label { display: flex; flex-direction: column; font-size: 13px; color: var(--muted); gap: 2px; }
label.check { flex-direction: row; align-items: center; gap: 4px; color: var(--fg); }
input[type=text] { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); min-width: 0; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
button.link { background: none; border: 0; color: var(--danger); padding: 0; }
.muted { color: var(--muted); } .revoked { color: var(--muted); text-decoration: line-through; }
.error { border-color: var(--danger); color: var(--danger); }
code, .token { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; } .token { font-size: 18px; padding: 12px; border: 1px dashed var(--line); border-radius: 8px; word-break: break-all; user-select: all; }
`;

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const u = (s: string) => encodeURIComponent(s);

function scopeText(p: UserView["passwords"][number]): string {
  const where = p.scope.collections === null ? "all collections" : p.scope.collections.map(esc).join(", ") || "no collections";
  return `${p.scope.access === "read" ? "read-only" : "read-write"}, ${where}`;
}

function userCard(user: UserView, origin: string): string {
  const base = `/admin/users/${u(user.username)}`;
  const passwords = user.passwords.length
    ? `<div class="scroll"><table><tr><th>Label</th><th>Access</th><th>Created</th><th>Last used</th><th></th></tr>${user.passwords
        .map(
          (p) => `<tr class="${p.revoked_at ? "revoked" : ""}"><td>${esc(p.label)} <span class="muted"><code>${esc(p.id)}</code></span></td>
            <td>${scopeText(p)}</td><td>${when(p.created_at)}</td><td>${when(p.last_used_at)}</td>
            <td>${p.revoked_at ? "revoked" : `<form class="inline" method="post" action="${base}/passwords/${u(p.id)}/revoke"><button class="link">Revoke</button></form>`}</td></tr>`,
        )
        .join("")}</table></div>`
    : `<p class="muted">No app passwords yet.</p>`;
  const collections = user.collections.length
    ? `<div class="scroll"><table><tr><th>Collection</th><th>Components</th><th>Objects</th><th>URL</th><th></th></tr>${user.collections
        .map(
          (c) => `<tr><td>${esc(c.displayname ?? c.slug)} <span class="muted">${esc(c.slug)}</span></td><td>${c.components.join(", ")}</td>
            <td>${c.objects} (${bytes(c.bytes)})</td><td><code>${esc(origin)}/dav/calendars/${esc(u(user.username))}/${esc(u(c.slug))}/</code></td>
            <td><form class="inline" method="post" action="${base}/collections/${u(c.slug)}/delete"><button class="link">Delete</button></form></td></tr>`,
        )
        .join("")}</table></div>`
    : `<p class="muted">No collections.</p>`;
  const collectionChecks = user.collections
    .map((c) => `<label class="check"><input type="checkbox" name="collections" value="${esc(c.slug)}"> ${esc(c.slug)}</label>`)
    .join("");
  return `<section class="card">
  <h2>${esc(user.username)}${user.is_admin ? ' <span class="muted">(admin)</span>' : ""}</h2>
  <h3>App passwords</h3>${passwords}
  <form method="post" action="${base}/passwords"><div class="row">
    <label>Label<input type="text" name="label" required maxlength="100" placeholder="iPhone"></label>
    <label class="check"><input type="checkbox" name="readonly" value="1"> read-only</label>
    ${collectionChecks ? `<span class="muted">limit to:</span>${collectionChecks}` : ""}
    <button>Issue app password</button></div></form>
  <h3>Collections</h3>${collections}
  <form method="post" action="${base}/collections"><div class="row">
    <label>Slug<input type="text" name="slug" required maxlength="64" placeholder="work"></label>
    <label>Name<input type="text" name="displayname" maxlength="200" placeholder="Work"></label>
    <label class="check"><input type="checkbox" name="components" value="VEVENT" checked> events</label>
    <label class="check"><input type="checkbox" name="components" value="VTODO"> tasks</label>
    <label class="check"><input type="checkbox" name="components" value="VJOURNAL"> journal</label>
    <button>Create collection</button></div></form>
  ${user.is_admin ? "" : `<form method="post" action="${base}/delete" class="row"><button class="link">Delete user (after deleting their collections)</button></form>`}
</section>`;
}

export function overview(users: UserView[], origin: string, failure?: { message: string; status: number }): Response {
  const error = failure?.message;
  return page(
    "CalDAV admin",
    `<h1>CalDAV admin</h1>
<p class="sub">Clients connect to <code>${esc(origin)}/</code> with a username and an app password. Apple devices can't create calendars or lists themselves on this server; create them here.</p>
${error ? `<div class="card error">${esc(error)}</div>` : ""}
<section class="card"><h2>New user</h2><form method="post" action="/admin/users"><div class="row">
  <label>Username<input type="text" name="username" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._@\\-]*"></label>
  <button>Create user</button></div></form>
  <p class="muted">New users get a <code>calendar</code> (events) and a <code>tasks</code> (tasks) collection.</p></section>
${users.map((user) => userCard(user, origin)).join("")}`,
    failure?.status ?? 200,
  );
}

export function tokenPage(username: string, label: string, token: string, origin: string): Response {
  return page(
    "App password issued",
    `<h1>App password for ${esc(username)}</h1>
<p class="sub">${esc(label)}. Copy it now; it is not shown again.</p>
<section class="card"><div class="token">${esc(token)}</div>
<table><tr><th>Server</th><td><code>${esc(origin)}/</code></td></tr><tr><th>Username</th><td><code>${esc(username)}</code></td></tr></table></section>
<p><a href="/admin">Back to admin</a></p>`,
  );
}
