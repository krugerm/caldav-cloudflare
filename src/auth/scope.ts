/**
 * What an app password may touch. Stored as JSON in app_passwords.scope_json:
 *   {"access": "read" | "read-write", "collections": ["slug", ...] | null}
 * NULL scope_json means read-write access to every collection.
 */
export interface Scope {
  access: "read" | "read-write";
  /** Collection slugs this password may see; null means all. */
  collections: string[] | null;
}

export const FULL_SCOPE: Scope = { access: "read-write", collections: null };

export function parseScope(json: string | null): Scope {
  if (!json) return FULL_SCOPE;
  const raw = JSON.parse(json) as Partial<Scope>;
  return {
    access: raw.access === "read" ? "read" : "read-write",
    collections: Array.isArray(raw.collections) ? raw.collections.map(String) : null,
  };
}

/** Validate scope input from the admin API; returns the JSON to store or throws. */
export function normaliseScope(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") throw new Error("scope must be an object");
  const s = input as Record<string, unknown>;
  if (s.access !== undefined && s.access !== "read" && s.access !== "read-write") throw new Error("scope.access must be 'read' or 'read-write'");
  if (s.collections !== undefined && s.collections !== null && !(Array.isArray(s.collections) && s.collections.every((x) => typeof x === "string")))
    throw new Error("scope.collections must be an array of slugs or null");
  const scope: Scope = { access: (s.access as Scope["access"]) ?? "read-write", collections: (s.collections as string[] | null) ?? null };
  return scope.access === "read-write" && scope.collections === null ? null : JSON.stringify(scope);
}

export const canSeeCollection = (scope: Scope, slug: string) => scope.collections === null || scope.collections.includes(slug);

export const canWrite = (scope: Scope) => scope.access === "read-write";

/** Creating or deleting collections needs unrestricted read-write access. */
export const canManageCollections = (scope: Scope) => scope.access === "read-write" && scope.collections === null;
