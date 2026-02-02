import { Pool } from 'pg';
import { taskStatus } from '../db/task.entity';

export interface ReapedTask {
    id: string;
    workflow_name: string;
    retry_count: number;
    action: 'requeued' | 'failed';
}

// Recovers stale tasks from dead workers - runs as singleton
export class Reaper {
    private readonly intervalMs: number;
    private readonly staleThresholdSeconds: number;
    private intervalHandle: NodeJS.Timeout | null = null;
    private running: boolean = false;

    constructor(
        private readonly pool: Pool,
        staleThresholdSeconds: number = 30,
        intervalMs: number = 10000
    ) {
        this.intervalMs = intervalMs;
        this.staleThresholdSeconds = staleThresholdSeconds;
    }

    start(): void {
        if (this.running) {
            console.warn('[reaper] already running');
            return;
        }

        this.running = true;
        console.log(`[reaper] started (interval: ${this.intervalMs}ms, stale threshold: ${this.staleThresholdSeconds}s)`);

        this.reap();
        this.intervalHandle = setInterval(() => this.reap(), this.intervalMs);
    }

    stop(): void {
        this.running = false;
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        console.log('[reaper] stopped');
    }

    isRunning(): boolean {
        return this.running;
    }

    async reap(): Promise<ReapedTask[]> {
        const reaped: ReapedTask[] = [];

        try {
            const requeuedTasks = await this.requeueStaleTasks();
            reaped.push(...requeuedTasks);

            const failedTasks = await this.failExhaustedTasks();
            reaped.push(...failedTasks);

            if (reaped.length > 0) {
                console.log(`[reaper] reaped ${reaped.length} tasks:`,
                    reaped.map(t => `${t.id} (${t.action})`).join(', '));
            }
        } catch (err) {
            console.error('[reaper] error during reap cycle:', err);
        }

        return reaped;
    }

    private async requeueStaleTasks(): Promise<ReapedTask[]> {
        const query = `
            UPDATE agent_tasks
            SET 
                status = $1,
                worker_id = NULL,
                retry_count = retry_count + 1,
                updated_at = NOW()
            WHERE status = $2
              AND heartbeat_at < NOW() - INTERVAL '${this.staleThresholdSeconds} seconds'
              AND retry_count < max_retries
            RETURNING id, workflow_name, retry_count
        `;

        const res = await this.pool.query(query, [taskStatus.PENDING, taskStatus.RUNNING]);

        return res.rows.map(row => ({
            id: row.id,
            workflow_name: row.workflow_name,
            retry_count: row.retry_count,
            action: 'requeued' as const
        }));
    }

    private async failExhaustedTasks(): Promise<ReapedTask[]> {
        const query = `
            UPDATE agent_tasks
            SET 
                status = $1,
                error = jsonb_build_object(
                    'message', 'Task exceeded max retries after worker failure',
                    'code', 'MAX_RETRIES_EXCEEDED'
                ),
                completed_at = NOW(),
                updated_at = NOW()
            WHERE status = $2
              AND heartbeat_at < NOW() - INTERVAL '${this.staleThresholdSeconds} seconds'
              AND retry_count >= max_retries
            RETURNING id, workflow_name, retry_count
        `;

        const res = await this.pool.query(query, [taskStatus.FAILED, taskStatus.RUNNING]);

        return res.rows.map(row => ({
            id: row.id,
            workflow_name: row.workflow_name,
            retry_count: row.retry_count,
            action: 'failed' as const
        }));
    }
}
