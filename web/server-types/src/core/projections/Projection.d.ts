/**
 * A projection folds the event log into a read model. Projections are pure with
 * respect to the log: replay the same events and you get the same state, so they
 * rebuild from Walrus on boot and never need their own migrations.
 */
import type { StoredEvent } from "../../domain/events";
export interface Projection {
    readonly name: string;
    apply(event: StoredEvent): void;
}
