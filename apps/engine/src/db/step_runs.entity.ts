export enum stepStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface StepRunsEntity {
  id: string;
  task_id: string;
  step_key: string;
  status: stepStatus;
  attempt: number;
  input: unknown;
  output: unknown | null;
  error: unknown | null;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
  compensation_fn: string | null;
  compensated_at: Date | null;
}
