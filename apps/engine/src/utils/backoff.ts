export function calculateBackOff(
  attempt: number,
  initialIntervalMs: number = 1000,
  backoffMultiplier: number = 2.0,
  maxInterval: number = 60000
): number {
  let delay = initialIntervalMs * Math.pow(backoffMultiplier, attempt);
  delay = Math.min(delay, maxInterval);
  const jitter = delay * 0.1;
  const randomJitter = Math.random() * jitter * 2 - jitter;
  return Math.floor(delay + randomJitter);
}
