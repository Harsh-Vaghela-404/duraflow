export interface WorkflowContext {
    runId: string;
    workflowName: string;
    input: unknown;
    step: StepRunner;
}

export interface StepRunner {
    run<T>(name: string, fn: () => Promise<T>, opts?: StepOptions<T>): Promise<T>;
}

export interface StepOptions<T = unknown> {
    retries?: number;
    timeout?: number;
    compensation?: (output: T) => Promise<void>;
}