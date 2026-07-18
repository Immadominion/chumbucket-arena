/**
 * Serialization for persisting events. superjson preserves bigint (FROST money)
 * and Date across the string boundary, so a round-trip through SQLite or Walrus
 * is lossless — the decoded payload is byte-for-byte the domain event again.
 */
import type { DomainEvent } from "../../domain/events";
export declare const encodeEvent: (event: DomainEvent) => string;
export declare const decodeEvent: (raw: string) => DomainEvent;
