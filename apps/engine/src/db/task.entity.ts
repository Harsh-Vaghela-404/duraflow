export enum taskStatus {
    PENDING = 'pending',
    RUNNING = 'running',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled',
}

export interface TaskEntity {
    id: string;
    workflow_name: string;
    status: taskStatus;
    input: Record<string, any>;
    output: Record<string, any> | null;
    error: Record<string, any> | null;
    priority: number;
    scheduled_at: Date | null;
    completed_at: Date | null;
    heartbeat_at: Date | null;
    worker_id: string | null;
    retry_count: number;
    max_retries: number;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
}