import { setTimeout as delay } from "node:timers/promises";

export const BINOM_REQUEST_TIMEOUT_MS = 30_000;

export class BinomRequestGate {
  private completedAt: number | undefined;
  private active = false;
  constructor(private readonly options: { minIntervalMs?: number } = {}) {}

  async beforeRequest(_mode: "read" | "write", signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active) throw new Error("Binom: a request is already in progress");
    this.active = true;
    try {
      const remaining = (this.completedAt ?? 0) + (this.options.minIntervalMs ?? 2500) - Date.now();
      if (remaining > 0) await delay(remaining, undefined, { signal });
      signal?.throwIfAborted();
    } catch (error) { this.active = false; throw error; }
  }

  async complete(_ok: boolean): Promise<void> {
    this.completedAt = Date.now();
    this.active = false;
  }
}
