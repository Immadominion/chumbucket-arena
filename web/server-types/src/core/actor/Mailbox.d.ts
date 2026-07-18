/**
 * A mailbox serialises async tasks: each task runs only after the previous one
 * settles, so an actor never processes two commands concurrently. This is how we
 * get per-stream consistency without locks — one writer per player stream.
 */
export declare class Mailbox {
    private tail;
    run<T>(task: () => Promise<T>): Promise<T>;
}
