// The backend is imported only for its `AppRouter` *type* (erased at runtime),
// but its module graph touches Bun's built-in sqlite. We never run it in the
// browser — this is just enough of a surface for the type graph to resolve.
declare module "bun:sqlite" {
  export interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  }
  export class Database {
    constructor(filename?: string, options?: unknown);
    run(sql: string, ...params: unknown[]): unknown;
    query(sql: string): Statement;
    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
    exec(sql: string): unknown;
    close(): void;
  }
}
