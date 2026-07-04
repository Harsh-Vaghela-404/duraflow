export interface WorkflowContext {
    runId: string;
    workflowName: string;
    input: unknown;
    step: StepRunner;
}

export interface StepRunner {
    run<T>(name: string, fn: () => Promise<T>, opts?: StepOptions<T>): Promise<T>;
}

export interface RateLimitOptions {
    api: string;
    tokens?: number;
    timeoutMs?: number;
}

export interface StepOptions<T = unknown> {
    retries?: number;
    timeout?: number;
    rateLimit?: RateLimitOptions;
}

// A compensation undoes a completed step during a saga rollback.
//
// It MUST be a pure function of the step's persisted `output` (the value the
// step returned, read back from the database). It may NOT close over live
// handler state — a rollback can run in a different process/thread than the one
// that executed the workflow (or after a crash), so any state that isn't in the
// step output is unavailable. This is the durability contract: everything a
// rollback needs must be reconstructable from durable storage.
export type Compensation<T = unknown> = (output: T) => Promise<void>;

export interface WorkflowOptions {
    // Compensations keyed by step key. Registered at module load under
    // `${workflowName}:${stepKey}` so they resolve in any process that loads
    // the workflow — including the engine's main thread, where rollback runs.
    compensations?: Record<string, Compensation>;
}
