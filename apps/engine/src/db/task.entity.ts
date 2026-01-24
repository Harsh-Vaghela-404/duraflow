/**
 * Lifecycle states for agent tasks.
 * Tasks progress: PENDING → RUNNING → COMPLETED/FAILED/CANCELLED
 */
export enum taskStatus {
    PENDING = 'pending',
    RUNNING = 'running',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled'
}

/**
 * Represents an agent task in the database.
 * Tasks are the top-level unit of work submitted via gRPC.
 */
export interface TaskEntity {
    id: string;
    workflow_name: string;
    status: taskStatus;
    input: Record<string, any>;
    output: Record<string, any>;
    error: Record<string, any>;
    priority: number;
    scheduled_at: Date;
    completed_at: Date;
    heartbeat_at: Date;  // For dead worker detection
    worker_id: string;
    retry_count: number;
    max_retries: number;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date;
}