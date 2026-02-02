export interface WorkflowContext {
    runId: string;
    workflowName: string;
    input: unknown;
    step: StepRunner;
}

export interface StepRunner {
    run<T>(name: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T>;
}

export interface StepOptions {
    retries?: number;
    timeout?: number;
    compensation?: (output: unknown) => Promise<void>;
}