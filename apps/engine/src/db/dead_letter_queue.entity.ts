export interface DeadLetterQueueEntity {
    id: string;
    task_id: string;
    step_id: string;
    error: Record<string, unknown> | null;
    retry_count: number;
    created_at: Date;
}
