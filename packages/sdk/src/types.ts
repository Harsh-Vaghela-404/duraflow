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
    compensation?: (output: T) => Promise<void>;
    rateLimit?: RateLimitOptions;
}
