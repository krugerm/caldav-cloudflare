import type { AppEnv, Config } from "../env";
import { randomToken, sha256Hex } from "../util/crypto";
import type { StoredBody } from "./objects";

export const R2_PREFIX = "bodies/";

/**
 * Decide where a body lives and compute its ETag. Large bodies are written
 * to R2 before the D1 batch runs; if the batch then fails, the orphan is
 * harmless and the daily sweep removes it. The key is the content hash plus a
 * per-PUT suffix, so two objects never share an R2 key (D-020).
 */
export async function storeBody(env: AppEnv, cfg: Config, bytes: Uint8Array, text: string): Promise<StoredBody> {
  const hash = await sha256Hex(bytes);
  const etag = `"${hash.slice(0, 32)}"`;
  if (bytes.byteLength < cfg.r2ThresholdBytes) return { inline: text, r2Key: null, size: bytes.byteLength, etag };
  const r2Key = `${R2_PREFIX}${hash}-${randomToken(9)}`;
  await env.BODIES.put(r2Key, bytes, { httpMetadata: { contentType: "text/calendar; charset=utf-8" } });
  return { inline: null, r2Key, size: bytes.byteLength, etag };
}

/**
 * Delete R2 bodies no object references, if older than `minAgeSeconds`. Keys are
 * unique per PUT, so an unreferenced key that old belongs to a PUT whose batch
 * failed or was replaced; no later write can start referencing it.
 */
export async function sweepOrphanBodies(env: AppEnv, now: number, minAgeSeconds = 86400): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await env.BODIES.list({ prefix: R2_PREFIX, cursor, limit: 500 });
    const old = page.objects.filter((o) => now - Math.floor(o.uploaded.getTime() / 1000) >= minAgeSeconds);
    if (old.length > 0) {
      const keys = old.map((o) => o.key);
      const referenced = new Set<string>();
      for (let i = 0; i < keys.length; i += 90) {
        const chunk = keys.slice(i, i + 90);
        const { results } = await env.DB.prepare(
          `SELECT DISTINCT body_r2_key FROM objects WHERE body_r2_key IN (${chunk.map(() => "?").join(",")})`,
        )
          .bind(...chunk)
          .all<{ body_r2_key: string }>();
        results.forEach((r) => referenced.add(r.body_r2_key));
      }
      const orphans = keys.filter((k) => !referenced.has(k));
      if (orphans.length > 0) {
        await env.BODIES.delete(orphans);
        deleted += orphans.length;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
