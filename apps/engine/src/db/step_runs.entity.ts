
export enum stepStatus {
    PENDING = 'pending',
    RUNNING = 'running',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled'
}

export interface StepRunsEntity {
    id: string
    task_id: string
    step_key: string
    status: stepStatus
    input: Record<string, any>
    output: Record<string, any>
    error: Record<string, any>
    started_at: Date
    completed_at: Date
    created_at: Date
}