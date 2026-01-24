/**
 * Lifecycle states for individual workflow steps.
 * Used for memoization and replay during crash recovery.
 */
export enum stepStatus {
    PENDING = 'pending',
    RUNNING = 'running',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled'
}

/**
 * Represents a single step execution within a task.
 * Steps are memoized to enable crash recovery and replay.
 */
export interface StepRunsEntity {
    id: string;
    task_id: string;
    step_key: string;  // Unique within workflow
    status: stepStatus;
    input: Record<string, any>;
    output: Record<string, any>;  // Cached for replay
    error: Record<string, any>;
    started_at: Date;
    completed_at: Date;
    created_at: Date;
}