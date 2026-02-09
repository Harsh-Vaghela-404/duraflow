import { monitorEventLoopDelay } from 'perf_hooks';

export class EventLoopMonitor {
    private monitor: ReturnType<typeof monitorEventLoopDelay>;

    constructor(resolution: number = 10) {
        this.monitor = monitorEventLoopDelay({ resolution });
        this.monitor.enable();
    }

    get lag(): number {
        return this.monitor.percentile(99) / 1000000;
    }

    disable(): void {
        this.monitor.disable();
    }
}
