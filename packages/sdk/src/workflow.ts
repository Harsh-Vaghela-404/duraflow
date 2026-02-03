import { WorkflowContext } from './types';

export type WorkflowHandler = (ctx: WorkflowContext) => Promise<unknown>;

export interface Workflow {
    name: string;
    handler: WorkflowHandler;
}

class Registry {
    private workflows = new Map<string, Workflow>();
    private static readonly NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
    private static readonly MAX_NAME_LENGTH = 100;

    register(name: string, handler: WorkflowHandler): Workflow {
        if (!name || name.length === 0) {
            throw new Error('Workflow name cannot be empty');
        }
        if (name.length > Registry.MAX_NAME_LENGTH) {
            throw new Error(`Workflow name exceeds maximum length of ${Registry.MAX_NAME_LENGTH} characters`);
        }
        if (!Registry.NAME_PATTERN.test(name)) {
            throw new Error('Workflow name must contain only alphanumeric characters, dashes, and underscores');
        }
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

export function workflow(name: string, handler: WorkflowHandler): Workflow {
    return globalRegistry.register(name, handler);
}
