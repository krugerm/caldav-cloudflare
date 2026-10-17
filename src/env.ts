import type { ChangeEvent } from "./events/event";

/** Bindings, vars and secrets the Worker receives. */
export interface AppEnv {
  DB: D1Database;
  BODIES: R2Bucket;
  CHANGES: Queue<ChangeEvent>;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  QUOTA_BYTES?: string;
  MAX_OBJECT_BYTES?: string;
  R2_THRESHOLD_BYTES?: string;
  CHANGE_RETENTION_DAYS?: string;
}

export interface Config {
  quotaBytes: number;
  maxObjectBytes: number;
  r2ThresholdBytes: number;
  changeRetentionDays: number;
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function config(env: AppEnv): Config {
  return {
    quotaBytes: num(env.QUOTA_BYTES, 1024 ** 3),
    maxObjectBytes: num(env.MAX_OBJECT_BYTES, 10 * 1024 ** 2),
    r2ThresholdBytes: num(env.R2_THRESHOLD_BYTES, 256 * 1024),
    changeRetentionDays: num(env.CHANGE_RETENTION_DAYS, 90),
  };
}
