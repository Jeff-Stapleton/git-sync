/** Exponential backoff with full jitter on the upper half: base * 2^attempt, capped. */
export function backoffDelay(attempt: number, baseMs = 5_000, capMs = 5 * 60_000, rand = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + (rand() * ceiling) / 2);
}
