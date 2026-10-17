import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** Fixtures as base64, so tests see the exact bytes on disk (BOM and line endings included). */
function readFixtures(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".ics"))
      .map((f) => [f, readFileSync(`${dir}/${f}`).toString("base64")]),
  );
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const fixtures = readFixtures("./tests/fixtures");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, FIXTURES: fixtures, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-secret-for-tests" },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
