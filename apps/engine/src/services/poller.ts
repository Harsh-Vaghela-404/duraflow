import { TaskRepository } from '../repositories/task.repository';
import { TaskEntity } from '../db/task.entity';

const TAG = '[poller]';

export interface PollerConfig {
    workerId: string;
    onTaskReceived: (task: TaskEntity) => Promise<void>;
    batchSize?: number;
    maxQueueSize?: number;
    checkBackpressure?: () => boolean;
}

export class Poller {
    private interval = 100;
    private readonly minInterval = 100;
    private readonly maxInterval = 500;
    private readonly batchSize: number;
    private running = false;
    private currentTimeout: NodeJS.Timeout | null = null;
    private readonly workerId: string;
    private readonly onTaskReceived: (task: TaskEntity) => Promise<void>;
    private readonly checkBackpressure?: () => boolean;

    constructor(
        private readonly taskRepo: TaskRepository,
        config: PollerConfig,
    ) {
        this.workerId = config.workerId;
        this.onTaskReceived = config.onTaskReceived;
        this.batchSize = config.batchSize || 10;
        this.checkBackpressure = config.checkBackpressure;
    }

    start(): void {
        if (this.running) {
            console.warn(`${TAG} already running`);
            return;
        }
        this.running = true;
        console.log(`${TAG} started (worker: ${this.workerId})`);
        this.poll();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.currentTimeout) {
            clearTimeout(this.currentTimeout);
            this.currentTimeout = null;
        }
        console.log(`${TAG} stopped`);
    }

    private async poll(): Promise<void> {
        if (!this.running) return;

        if (this.checkBackpressure && this.checkBackpressure()) {
            console.warn(`${TAG} backpressure detected, skipping poll`);
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
                    this.onTaskReceived(task).catch(
                        err => console.error(`${TAG} task ${task.id} callback error:`, err),
                    );
                }
            } else {
                // backoff: 100 -> 200 -> 400 -> 500ms cap
                this.interval = Math.min(this.interval * 2, this.maxInterval);
            }
        } catch (err) {
            console.error(`${TAG} dequeue error:`, err);
            this.interval = this.maxInterval;
        }

        if (this.running) {
            this.currentTimeout = setTimeout(() => this.poll(), this.interval);
        }
    }
}
