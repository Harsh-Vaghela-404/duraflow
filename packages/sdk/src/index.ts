// public api for @duraflow/sdk
// usage:
//   import { workflow, step } from '@duraflow/sdk';
//   const agent = workflow('name', async (ctx) => { ... });

export type StepFn<T> = () => Promise<T>;
export type CompensationFn = (output: unknown) => Promise<void>;

export interface StepOptions {
    compensation?: CompensationFn;
    retries?: number;
    timeout?: number;
}

export interface Context {
    runId: string;
    workflowId: string;
    input: unknown;
}

export interface StepRunner {
    run<T>(name: string, fn: StepFn<T>, opts?: StepOptions): Promise<T>;
}

export type WorkflowHandler = (ctx: Context & { step: StepRunner }) => Promise<unknown>;

export interface Workflow {
    name: string;
    handler: WorkflowHandler;
}

const registry = new Map<string, Workflow>();

export function workflow(name: string, handler: WorkflowHandler): Workflow {
    if (registry.has(name)) {
        throw new Error(`workflow "${name}" already registered`);
    }
    const wf = { name, handler };
    registry.set(name, wf);
    return wf;
}

export function getWorkflow(name: string): Workflow | undefined {
    return registry.get(name);
}

export function listWorkflows(): string[] {
    return Array.from(registry.keys());
}
