import { TaskRepository } from '../repositories/task.repository';

const TAG = '[heartbeat]';

export class HeartbeatService {
    private readonly intervalMs: number;
    private intervals = new Map<string, NodeJS.Timeout>();

    constructor(private readonly taskRepo: TaskRepository, intervalMs = 5000) {
        this.intervalMs = intervalMs;
    }

    start(taskId: string): void {
        if (this.intervals.has(taskId)) return;

        const handle = setInterval(async () => {
            try {
                await this.taskRepo.updateHeartbeat(taskId);
            } catch (err) {
                console.error(`${TAG} failed to update heartbeat for task ${taskId}:`, err);
            }
        }, this.intervalMs);

        this.intervals.set(taskId, handle);
        console.log(`${TAG} started for task ${taskId}`);
    }

    stop(taskId: string): void {
        const handle = this.intervals.get(taskId);
        if (!handle) return;
        clearInterval(handle);
        this.intervals.delete(taskId);
        console.log(`${TAG} stopped for task ${taskId}`);
    }

    stopAll(): void {
        for (const taskId of this.intervals.keys()) {
            this.stop(taskId);
        }
    }
}
