import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { taskStatus } from '../db/task.entity';
import { LeaderElector } from './leaderelector';

export interface ReapedTask {
    id: string;
    workflow_name: string;
    retry_count: number;
    action: 'requeued' | 'failed';
}

// Recovers stale tasks from dead workers - runs as singleton via Redis leader election
export class Reaper {
    private readonly intervalMs: number;
    private readonly staleThresholdSeconds: number;
    private intervalHandle: NodeJS.Timeout | null = null;
    private running: boolean = false;
    private leaderElector: LeaderElector;

    constructor(
        private readonly pool: Pool,
        redis: Redis,
        staleThresholdSeconds: number = 30,
        intervalMs: number = 10000
    ) {
        this.intervalMs = intervalMs;
        this.staleThresholdSeconds = staleThresholdSeconds;
        this.leaderElector = new LeaderElector(redis);
    }

    async start(): Promise<void> {
        if (this.running) {
            console.warn('[reaper] already running');
            return;
        }

        const isLeader = await this.leaderElector.tryBecomeLeader();
        if (!isLeader) {
            console.log('[reaper] another instance is leader, skipping');
            return;
        }

        this.running = true;
        console.log(`[reaper] started as leader (interval: ${this.intervalMs}ms, stale threshold: ${this.staleThresholdSeconds}s)`);

        this.reap();
        this.intervalHandle = setInterval(() => this.reap(), this.intervalMs);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        await this.leaderElector.releaseLeadership();
        console.log('[reaper] stopped and released leadership');
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
