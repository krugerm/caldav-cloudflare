import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

export const ADMIN = { username: "admin", password: "integration-admin-secret" };

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
    admin: { username: string; password: string };
    persistDir: string;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

let dev: ChildProcess | undefined;
let persist: string | undefined;

export async function setup(project: TestProject) {
  persist = mkdtempSync(join(tmpdir(), "caldav-cf-it-"));
  const wrangler = join(process.cwd(), "node_modules", ".bin", "wrangler");
  execFileSync(wrangler, ["d1", "migrations", "apply", "caldav", "--local", "--persist-to", persist], {
    env: { ...process.env, CI: "1" },
    stdio: "pipe",
  });
  const port = await freePort();
  dev = spawn(
    wrangler,
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist, "--show-interactive-dev-session=false",
      "--var", `ADMIN_USERNAME:${ADMIN.username}`, "--var", `ADMIN_PASSWORD:${ADMIN.password}`],
    { env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  dev.stdout?.on("data", (d) => (log += d));
  dev.stderr?.on("data", (d) => (log += d));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(baseUrl + "/")).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline || dev.exitCode !== null) throw new Error(`wrangler dev did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  project.provide("baseUrl", baseUrl);
  project.provide("admin", ADMIN);
  project.provide("persistDir", persist);
}

export async function teardown() {
  dev?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (persist) rmSync(persist, { recursive: true, force: true });
}
