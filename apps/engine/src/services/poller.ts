import { TaskRepository } from '../repositories/task.repository';
import { TaskEntity } from '../db/task.entity';

export class Poller {
    private interval: number = 100;
    private readonly minInterval: number = 100;
    private readonly maxInterval: number = 500;
    private readonly batchSize: number;
    private running: boolean = false;
    private currentTimeout: NodeJS.Timeout | null = null;

    constructor(
        private readonly taskRepo: TaskRepository,
        private readonly workerId: string,
        private readonly onTaskReceived: (task: TaskEntity) => Promise<void>,
        batchSize: number = 10,
        private readonly checkBackpressure?: () => boolean
    ) {
        this.batchSize = batchSize;
    }

    start(): void {
        if (this.running) {
            console.warn('[poller] already running');
            return;
        }
        this.running = true;
        console.log(`[poller] started (worker: ${this.workerId})`);
        this.poll();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.currentTimeout) {
            clearTimeout(this.currentTimeout);
            this.currentTimeout = null;
        }
        console.log('[poller] stopped');
    }

    private async poll(): Promise<void> {
        if (!this.running) return;

        if (this.checkBackpressure && this.checkBackpressure()) {
            console.warn('[poller] backpressure detected, skipping poll');
            if (this.running) {
                this.currentTimeout = setTimeout(() => this.poll(), 1000);
            }
            return;
        }

        try {
            const tasks = await this.taskRepo.dequeue(this.batchSize, this.workerId);

            if (tasks.length > 0) {
                this.interval = this.minInterval;
                for (const task of tasks) {
                    if (!this.running) break;
                    try {
                        await this.onTaskReceived(task);
                    } catch (err) {
                        console.error(`[poller] task ${task.id} callback error:`, err);
                    }
                }
            } else {
                // backoff: 100 -> 200 -> 400 -> 500ms cap
                this.interval = Math.min(this.interval * 2, this.maxInterval);
            }
        } catch (err) {
            console.error('[poller] dequeue error:', err);
            this.interval = this.maxInterval;
        }

        if (this.running) {
            this.currentTimeout = setTimeout(() => this.poll(), this.interval);
        }
    }
}
