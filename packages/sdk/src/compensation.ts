export type CompensationFn<T = unknown> = (output: T) => Promise<void>;

// Global registry mapping a named key to its compensation function.
// Keys are auto-generated as `${workflowName}:${stepName}` when registered
// via step.run(), so callers rarely interact with this directly.
class CompensationRegistry {
    private fns = new Map<string, CompensationFn>();

    register(name: string, fn: CompensationFn): void {
        if (this.fns.has(name)) {
            // Overwriting is intentional — hot reload or duplicate registration
            // during tests should be idempotent.
            this.fns.set(name, fn);
        } else {
            this.fns.set(name, fn);
        }
    }

    get(name: string): CompensationFn | undefined {
        return this.fns.get(name);
    }

    has(name: string): boolean {
        return this.fns.has(name);
    }

    list(): string[] {
        return Array.from(this.fns.keys());
    }
}

export const compensationRegistry = new CompensationRegistry();

/**
 * Register a compensation function by name.
 * Called automatically by step.run() when a `compensation` option is provided.
 * Can also be called manually if you want a stable, human-readable key.
 *
 * @example
 * registerCompensation('send-email:undo', async (output) => {
 *   await emailService.cancel(output.messageId);
 * });
 */
export function registerCompensation<T = unknown>(name: string, fn: CompensationFn<T>): void {
    compensationRegistry.register(name, fn as CompensationFn);
}
