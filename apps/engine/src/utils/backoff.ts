// Exponential backoff: base-4 gives 1s → 4s → 16s → 64s (capped at maxInterval).
// attempt is 1-indexed; attempt=1 waits initialIntervalMs, attempt=2 waits 4x that, etc.
export function calculateBackOff(
  attempt: number,
  initialIntervalMs: number = 1000,
  backoffMultiplier: number = 4.0,
  maxInterval: number = 60000
): number {
  let delay = initialIntervalMs * Math.pow(backoffMultiplier, attempt - 1);
  delay = Math.min(delay, maxInterval);
  // ±10% jitter to avoid thundering herd
  const jitter = delay * 0.1;
  const randomJitter = Math.random() * jitter * 2 - jitter;
  return Math.floor(delay + randomJitter);
}
