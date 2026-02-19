import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { taskStatus } from '../db/task.entity';
import { LeaderElector } from './leaderelector';

const TAG = '[reaper]';

export interface ReapedTask {
    id: string;
    workflow_name: string;
    retry_count: number;
    action: 'requeued' | 'failed';
}

// Recovers stale tasks from dead workers. Runs on only one instance at a time
// via Redis leader election — so the cluster can't double-requeue the same task.
export class Reaper {
    private readonly intervalMs: number;
    private readonly staleThresholdSeconds: number;
    private intervalHandle: NodeJS.Timeout | null = null;
    private running = false;
    private isReaping = false;
    private leaderElector: LeaderElector;

    constructor(
        private readonly pool: Pool,
        redis: Redis,
        staleThresholdSeconds = 300,
        intervalMs = 10_000,
    ) {
        this.staleThresholdSeconds = staleThresholdSeconds;
        this.intervalMs = intervalMs;
        this.leaderElector = new LeaderElector(redis);
    }

    async start(): Promise<void> {
        if (this.running) {
            console.warn(`${TAG} already running`);
            return;
        }

        const isLeader = await this.leaderElector.tryBecomeLeader();
        if (!isLeader) {
            console.log(`${TAG} another instance is leader, skipping`);
            return;
        }

        this.running = true;
        console.log(`${TAG} started as leader (interval: ${this.intervalMs}ms, stale threshold: ${this.staleThresholdSeconds}s)`);

        // Fire immediately, then on schedule
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
        console.log(`${TAG} stopped`);
    }

    isRunning(): boolean {
        return this.running;
    }

    async reap(): Promise<ReapedTask[]> {
        if (this.isReaping) return [];
        this.isReaping = true;

        const reaped: ReapedTask[] = [];

        try {
            reaped.push(...await this.requeueStaleTasks());
            reaped.push(...await this.failExhaustedTasks());

            if (reaped.length > 0) {
                console.log(`${TAG} reaped ${reaped.length} tasks: ${reaped.map(t => `${t.id}(${t.action})`).join(', ')}`);
            }
        } catch (err) {
            console.error(`${TAG} error during reap cycle:`, err);
        } finally {
            this.isReaping = false;
        }

        return reaped;
    }

    private async requeueStaleTasks(): Promise<ReapedTask[]> {
        const res = await this.pool.query(
            `UPDATE agent_tasks
             SET status = $1, worker_id = NULL, retry_count = retry_count + 1, updated_at = NOW()
             WHERE status = $2
               AND heartbeat_at < NOW() - (INTERVAL '1 second' * $3)
               AND retry_count < max_retries
             RETURNING id, workflow_name, retry_count`,
            [taskStatus.PENDING, taskStatus.RUNNING, this.staleThresholdSeconds],
        );

        return res.rows.map(row => ({ id: row.id, workflow_name: row.workflow_name, retry_count: row.retry_count, action: 'requeued' as const }));
    }

    private async failExhaustedTasks(): Promise<ReapedTask[]> {
        const res = await this.pool.query(
            `UPDATE agent_tasks
             SET status = $1,
                 error = jsonb_build_object('message', 'Task exceeded max retries after worker failure', 'code', 'MAX_RETRIES_EXCEEDED'),
                 completed_at = NOW(),
                 updated_at = NOW()
             WHERE status = $2
               AND heartbeat_at < NOW() - (INTERVAL '1 second' * $3)
               AND retry_count >= max_retries
             RETURNING id, workflow_name, retry_count`,
            [taskStatus.FAILED, taskStatus.RUNNING, this.staleThresholdSeconds],
        );

        return res.rows.map(row => ({ id: row.id, workflow_name: row.workflow_name, retry_count: row.retry_count, action: 'failed' as const }));
    }
}
