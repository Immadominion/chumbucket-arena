/**
 * Durable event store on SQLite (bun:sqlite — zero external deps). Same contract
 * as the in-memory store, so the system is identical above it; this is what lets
 * game state survive a restart or redeploy. The append-only log is the source of
 * truth on disk; projections rebuild from it on boot via ReadModel.hydrate.
 *
 * On Railway, point EVENT_LOG_PATH at a mounted volume. (Walrus mirroring of the
 * log is a later upgrade — this makes the operational store durable today.)
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DomainError } from "../../domain/errors.ts";
import type { DomainEvent, StoredEvent } from "../../domain/events.ts";
import { newEventId } from "../../domain/ids.ts";
import { decodeEvent, encodeEvent } from "./codec.ts";
import type { AppendOptions, EventListener, EventStore } from "./EventStore.ts";

interface Row {
  id: string;
  stream_id: string;
  version: number;
  at: number;
  payload: string;
}

const rowToStored = (r: Row): StoredEvent => ({
  meta: { id: r.id as StoredEvent["meta"]["id"], streamId: r.stream_id, version: r.version, at: r.at },
  payload: decodeEvent(r.payload),
});

export class SqliteEventStore implements EventStore {
  private readonly db: Database;
  private readonly listeners = new Set<EventListener>();
  private readonly insertStmt;
  private readonly countStmt;
  private readonly streamStmt;
  private readonly allStmt;

  constructor(
    path = "./data/events.sqlite",
    private readonly now: () => number = () => Date.now(),
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        id        TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        version   INTEGER NOT NULL,
        at        INTEGER NOT NULL,
        type      TEXT NOT NULL,
        payload   TEXT NOT NULL,
        UNIQUE (stream_id, version)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_events_stream ON events (stream_id, version)");

    this.insertStmt = this.db.query(
      "INSERT INTO events (id, stream_id, version, at, type, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.countStmt = this.db.query("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?");
    this.streamStmt = this.db.query(
      "SELECT id, stream_id, version, at, payload FROM events WHERE stream_id = ? AND version >= ? ORDER BY version",
    );
    this.allStmt = this.db.query(
      "SELECT id, stream_id, version, at, payload FROM events ORDER BY seq LIMIT -1 OFFSET ?",
    );
  }

  async append(
    streamId: string,
    events: DomainEvent[],
    opts?: AppendOptions,
  ): Promise<StoredEvent[]> {
    const stored = this.insertTxn(streamId, events, opts?.expectedVersion);
    for (const e of stored) {
      for (const listener of this.listeners) {
        try {
          await listener(e);
        } catch (err) {
          console.error(`[eventstore] listener failed on ${e.payload.type}:`, err);
        }
      }
    }
    return stored;
  }

  private insertTxn(
    streamId: string,
    events: DomainEvent[],
    expectedVersion?: number,
  ): StoredEvent[] {
    const run = this.db.transaction(() => {
      const current = (this.countStmt.get(streamId) as { n: number }).n;
      if (expectedVersion !== undefined && expectedVersion !== current) {
        throw new DomainError(
          "CONFLICT",
          `stream ${streamId} is at v${current}, expected v${expectedVersion}`,
          { streamId, expected: expectedVersion, actual: current },
        );
      }
      const at = this.now();
      const out: StoredEvent[] = [];
      let version = current;
      for (const payload of events) {
        const id = newEventId();
        this.insertStmt.run(id, streamId, version, at, payload.type, encodeEvent(payload));
        out.push({ meta: { id, streamId, version, at }, payload });
        version += 1;
      }
      return out;
    });
    return run();
  }

  async readStream(streamId: string, fromVersion = 0): Promise<StoredEvent[]> {
    return (this.streamStmt.all(streamId, fromVersion) as Row[]).map(rowToStored);
  }

  async readAll(fromGlobal = 0): Promise<StoredEvent[]> {
    return (this.allStmt.all(fromGlobal) as Row[]).map(rowToStored);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.db.close();
  }
}
