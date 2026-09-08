/** Feedback-only capacity control. Each permit covers one actual model request. */
type Waiter = {
  signal?: AbortSignal;
  resolve: (epoch: number) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
};
type Provider = {
  capacity: number;
  active: number;
  healthy: number;
  epoch: number;
  timeouts: number;
  backoff: number;
  cooldownUntil: number;
  waiters: Waiter[];
};
export const MAX_FEEDBACK_REQUESTS = 50;

function capacityFailure(error: unknown) {
  const failure = error as { status?: number; name?: string; message?: string; headers?: Headers | Record<string, string> };
  const timeout = /timeout|timed out/i.test(`${failure?.name ?? ""} ${failure?.message ?? ""}`);
  const network = /APIConnectionError|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|connection error/i.test(`${failure?.name ?? ""} ${failure?.message ?? ""}`);
  const congestion = [429, 502, 503, 504].includes(failure?.status ?? 0)
    || ((failure?.status ?? 0) >= 500 && /overload|capacity|too many|busy/i.test(failure?.message ?? ""));
  const header = failure?.headers instanceof Headers ? failure.headers.get("retry-after") : failure?.headers?.["retry-after"];
  const retryAfter = header ? Number(header) : NaN;
  return { retryable: timeout || network || congestion, timeout,
    retryAfterMs: header ? Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.max(0, Date.parse(header) - Date.now()) || 0 : 0 };
}

export class FeedbackRequestCapacity {
  private providers = new Map<string, Provider>();
  private active = 0;
  private wakeup: ReturnType<typeof setTimeout> | undefined;

  reset() {
    if (this.active || [...this.providers.values()].some((pool) => pool.waiters.length)) throw new Error("Feedback requests are still active");
    if (this.wakeup) clearTimeout(this.wakeup);
    this.wakeup = undefined;
    this.providers.clear();
  }

  snapshot() {
    return {
      active: this.active,
      maximum: MAX_FEEDBACK_REQUESTS,
      providers: [...this.providers.values()].map((pool) => ({ capacity: pool.capacity, active: pool.active,
        waiting: pool.waiters.length, cooldownMs: Math.max(0, pool.cooldownUntil - Date.now()) })),
    };
  }

  private provider(key: string) {
    let pool = this.providers.get(key);
    if (!pool) {
      pool = { capacity: 1, active: 0, healthy: 0, epoch: 0, timeouts: 0, backoff: 0, cooldownUntil: 0, waiters: [] };
      this.providers.set(key, pool);
    }
    return pool;
  }

  private pump() {
    if (this.wakeup) clearTimeout(this.wakeup);
    this.wakeup = undefined;
    let changed = true;
    while (changed && this.active < MAX_FEEDBACK_REQUESTS) {
      changed = false;
      for (const pool of this.providers.values()) {
        if (this.active >= MAX_FEEDBACK_REQUESTS) break;
        if (!pool.waiters.length || pool.active >= pool.capacity || pool.cooldownUntil > Date.now()) continue;
        const waiter = pool.waiters.shift()!;
        if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
        pool.active++; this.active++;
        waiter.resolve(pool.epoch);
        changed = true;
      }
    }
    const waits = [...this.providers.values()].filter((pool) => pool.waiters.length && pool.cooldownUntil > Date.now())
      .map((pool) => pool.cooldownUntil - Date.now());
    if (waits.length) this.wakeup = setTimeout(() => this.pump(), Math.max(1, Math.min(...waits)));
  }

  private acquire(pool: Provider, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.abort = () => {
        pool.waiters = pool.waiters.filter((entry) => entry !== waiter);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        this.pump();
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      pool.waiters.push(waiter);
      this.pump();
    });
  }

  async run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const pool = this.provider(key);
    for (let retry = 0; ; retry++) {
      const epoch = await this.acquire(pool, signal);
      try {
        signal?.throwIfAborted();
        const result = await operation();
        pool.timeouts = 0;
        pool.backoff = 0;
        if (epoch === pool.epoch) {
          pool.healthy++;
          if (pool.healthy >= pool.capacity && pool.capacity < MAX_FEEDBACK_REQUESTS) {
            pool.capacity++; pool.healthy = 0; pool.epoch++;
          }
        }
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = capacityFailure(error);
        if (!failure.retryable) throw error;
        if (failure.timeout) pool.timeouts++;
        if (!failure.timeout || pool.timeouts >= 2) {
          pool.capacity = Math.max(1, Math.floor(pool.capacity / 2));
          pool.healthy = 0; pool.epoch++; pool.timeouts = 0;
        }
        const delay = Math.min(60_000, 5_000 * 2 ** Math.min(pool.backoff++, 4));
        pool.cooldownUntil = Math.max(pool.cooldownUntil, Date.now() + Math.max(delay, failure.retryAfterMs));
        if (retry >= 2) throw error;
      } finally {
        pool.active--; this.active--;
        this.pump();
      }
    }
  }
}

export const feedbackRequestCapacity = new FeedbackRequestCapacity();
