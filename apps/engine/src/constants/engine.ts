// Shared engine constants. Import from here - do NOT inline these values in service files.

export const POLL_MIN_INTERVAL_MS = 100;
export const POLL_MAX_INTERVAL_MS = 500;
export const POLL_BATCH_SIZE = 10;
export const POLL_BACKPRESSURE_RETRY_MS = 1000;

export const HEARTBEAT_INTERVAL_MS = 5000;

export const REAPER_STALE_THRESHOLD_SECONDS = 30;
export const REAPER_INTERVAL_MS = 10_000;

export const LEADER_TTL_SECONDS = 30;

export const IPC_TIMEOUT_MS = 30_000;
export const PISCINA_MAX_QUEUE = 1000;
export const PISCINA_IDLE_TIMEOUT_MS = 30_000;

export const MAX_QUEUE_SIZE = 1000;
export const MAX_EVENT_LOOP_LAG_MS = 100;
