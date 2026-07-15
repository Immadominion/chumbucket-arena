/**
 * A mailbox serialises async tasks: each task runs only after the previous one
 * settles, so an actor never processes two commands concurrently. This is how we
 * get per-stream consistency without locks — one writer per player stream.
 */

export class Mailbox {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Keep the chain alive even if a task rejects; callers see their own error.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
