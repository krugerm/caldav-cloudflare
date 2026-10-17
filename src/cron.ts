import { config, type AppEnv } from "./env";
import { republishPending } from "./events/publish";
import { sweepOrphanBodies } from "./store/bodies";
import { nowSeconds } from "./util/time";

export const EVERY_MINUTE = "* * * * *";

/** Drop published change rows past retention, recording per collection how far the log was cut. */
export async function pruneChanges(env: AppEnv, now: number): Promise<void> {
  const cutoff = now - config(env).changeRetentionDays * 86400;
  await env.DB.batch([
    env.DB.prepare(
      // MAX with the current value: rows published late can sit below an earlier cut,
      // and lowering the mark would revive tokens whose change rows are gone
      `UPDATE collections SET pruned_revision = MAX(pruned_revision, (
         SELECT MAX(revision) FROM changes WHERE collection_id = collections.id AND at < ? AND published = 1))
       WHERE id IN (SELECT collection_id FROM changes WHERE at < ? AND published = 1)`,
    ).bind(cutoff, cutoff),
    env.DB.prepare(
      `DELETE FROM changes WHERE published = 1
       AND revision <= (SELECT pruned_revision FROM collections WHERE id = changes.collection_id)`,
    ),
    // deleted collections whose events have all gone out and whose log has aged out
    env.DB.prepare(
      `DELETE FROM collections WHERE deleted_at IS NOT NULL AND deleted_at < ?
       AND NOT EXISTS (SELECT 1 FROM changes WHERE collection_id = collections.id AND published = 0)`,
    ).bind(cutoff),
  ]);
}

export async function runScheduled(cron: string, env: AppEnv, scheduledTime: number): Promise<void> {
  const now = Math.floor(scheduledTime / 1000) || nowSeconds();
  if (cron === EVERY_MINUTE) {
    await republishPending(env, now);
    return;
  }
  await pruneChanges(env, now);
  await sweepOrphanBodies(env, now);
}
