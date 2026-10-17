import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** tests/fixtures/*.ics, base64-encoded, by file name. */
      FIXTURES: Record<string, string>;
      ADMIN_USERNAME: string;
      ADMIN_PASSWORD: string;
    }
  }
}
