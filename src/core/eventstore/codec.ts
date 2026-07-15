/**
 * Serialization for persisting events. superjson preserves bigint (FROST money)
 * and Date across the string boundary, so a round-trip through SQLite or Walrus
 * is lossless — the decoded payload is byte-for-byte the domain event again.
 */

import superjson from "superjson";
import type { DomainEvent } from "../../domain/events.ts";

export const encodeEvent = (event: DomainEvent): string => superjson.stringify(event);

export const decodeEvent = (raw: string): DomainEvent => superjson.parse<DomainEvent>(raw);
