/** Message published on the caldav-changes Queue for every write. */
export interface ChangeEvent {
  v: 1;
  id: string;
  type:
    | "object.created"
    | "object.updated"
    | "object.deleted"
    | "collection.created"
    | "collection.updated"
    | "collection.deleted";
  user: string;
  collection: string;
  object?: string;
  uid?: string;
  component?: string;
  etag?: string;
  revision: number;
  actor: string;
  at: string;
}
