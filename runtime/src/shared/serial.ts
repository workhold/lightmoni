export class Serial {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
export class Semaphore {
  private active = 0;
  private waiting: {
    resolve: () => void;
    reject: (e: unknown) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }[] = [];
  constructor(readonly capacity: number) {}
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.capacity)
      await new Promise<void>((resolve, reject) => {
        const item = {
          resolve,
          reject,
          signal,
          abort: () => {
            this.waiting = this.waiting.filter((v) => v !== item);
            reject(signal?.reason ?? Error("aborted"));
          },
        };
        signal?.addEventListener("abort", item.abort, { once: true });
        this.waiting.push(item);
      });
    else this.active++;
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.abort!);
        next.resolve();
      } else this.active--;
    }
  }
}
