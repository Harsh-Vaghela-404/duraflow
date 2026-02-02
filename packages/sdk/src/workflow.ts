import { WorkflowContext } from './types';

export type WorkflowHandler = (ctx: WorkflowContext) => Promise<unknown>;

export interface Workflow {
    name: string;
    handler: WorkflowHandler;
}

class Registry {
    private workflows = new Map<string, Workflow>();

    register(name: string, handler: WorkflowHandler): Workflow {
        if (this.workflows.has(name)) {
            throw new Error(`Workflow "${name}" is already registered.`);
        }
        const wf: Workflow = { name, handler };
        this.workflows.set(name, wf);
        return wf;
    }

    get(name: string): Workflow | undefined {
        return this.workflows.get(name);
    }

    list(): string[] {
        return Array.from(this.workflows.keys());
    }
}

export const globalRegistry = new Registry();

/**
 * Define and register a new workflow.
 * @param name Unique name of the workflow
 * @param handler The async function implementing the workflow logic
 */
export function workflow(name: string, handler: WorkflowHandler): Workflow {
    return globalRegistry.register(name, handler);
}
