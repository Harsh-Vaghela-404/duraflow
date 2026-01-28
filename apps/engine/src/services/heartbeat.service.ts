import { TaskRepository } from '../repositories/task.repository';

/**
 * Maintains worker liveness by periodically updating heartbeat_at for running tasks.
 * Only one task can be tracked at a time per instance.
 */
export class HeartbeatService {
    private readonly intervalMs: number;
    private intervalHandle: NodeJS.Timeout | null = null;
    private currentTaskId: string | null = null;

    constructor(
        private readonly taskRepo: TaskRepository,
        intervalMs: number = 5000
    ) {
        this.intervalMs = intervalMs;
    }

    start(taskId: string): void {
        if (this.intervalHandle) {
            console.warn(`[heartbeat] already running for task ${this.currentTaskId}, stopping first`);
            this.stop();
        }

        this.currentTaskId = taskId;
        console.log(`[heartbeat] started for task ${taskId} (interval: ${this.intervalMs}ms)`);

        this.tick();
        this.intervalHandle = setInterval(() => this.tick(), this.intervalMs);
    }

    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
            console.log(`[heartbeat] stopped for task ${this.currentTaskId}`);
            this.currentTaskId = null;
        }
    }

    isRunning(): boolean {
        return this.intervalHandle !== null;
    }

    getCurrentTaskId(): string | null {
        return this.currentTaskId;
    }

    private async tick(): Promise<void> {
        if (!this.currentTaskId) return;

        try {
            await this.taskRepo.updateHeartbeat(this.currentTaskId);
        } catch (err) {
            console.error(`[heartbeat] failed to update for task ${this.currentTaskId}:`, err);
        }
    }
}
