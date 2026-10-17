import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage persists between tests in a file, so each test starts from empty tables.
beforeEach(async () => {
  await env.DB.batch(
    ["changes", "objects", "collections", "app_passwords", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  const listed = await env.BODIES.list();
  if (listed.objects.length > 0) await env.BODIES.delete(listed.objects.map((o) => o.key));
});
