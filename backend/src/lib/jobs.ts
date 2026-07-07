/**
 * In-process async job queue (build plan §2.2: async AI work never blocks the
 * request path). Extractable to a real queue when the AI module is split out.
 */
export class JobQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;
  private idleResolvers: Array<() => void> = [];

  enqueue(job: () => Promise<void>): void {
    this.queue.push(job);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        await job();
      } catch (err) {
        // Jobs are enrichment — failure degrades, never breaks (item stays usable).
        console.error('job failed:', err instanceof Error ? err.message : err);
      }
    }
    this.running = false;
    for (const r of this.idleResolvers.splice(0)) r();
  }

  /** Test helper: resolves when the queue is fully drained. */
  async onIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }
}
