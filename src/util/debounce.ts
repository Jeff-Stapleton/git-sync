/**
 * Trailing debounce with a max-wait ceiling: fires `delayMs` after the last
 * trigger, but never later than `maxWaitMs` after the first trigger of a burst.
 */
export class Debouncer {
  private timer?: ReturnType<typeof setTimeout>;
  private firstAt = 0;

  constructor(private fn: () => void, private delayMs: number, private maxWaitMs: number) {}

  setDelay(delayMs: number) {
    this.delayMs = delayMs;
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }

  trigger() {
    const now = Date.now();
    if (this.timer === undefined) this.firstAt = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delayMs, this.firstAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fn();
    }, wait);
  }

  cancel() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
