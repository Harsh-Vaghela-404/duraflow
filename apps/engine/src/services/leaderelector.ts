import { Redis } from 'ioredis';

const LEADER_KEY = 'duraflow:reaper:leader';
const TAG = '[leader]';

export class LeaderElector {
    private readonly workerId: string;
    private renewalInterval: NodeJS.Timeout | null = null;

    constructor(private readonly redis: Redis, workerId?: string) {
        this.workerId = workerId || `worker-${process.pid}-${Date.now()}`;
    }

    private get leaderTtl(): number {
        return parseInt(process.env.LEADER_TTL_SECONDS || '30', 10);
    }

    async tryBecomeLeader(): Promise<boolean> {
        const result = await this.redis.set(LEADER_KEY, this.workerId, 'EX', this.leaderTtl, 'NX');
        if (result === 'OK') {
            this.startRenewal();
            console.log(`${TAG} ${this.workerId} elected as leader`);
            return true;
        }
        return false;
    }

    async releaseLeadership(): Promise<void> {
        this.stopRenewal();
        // Lua script ensures only the current leader can delete the key
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        await this.redis.eval(script, 1, LEADER_KEY, this.workerId);
        console.log(`${TAG} ${this.workerId} released leadership`);
    }

    async isLeader(): Promise<boolean> {
        const current = await this.redis.get(LEADER_KEY);
        return current === this.workerId;
    }

    private startRenewal(): void {
        const renewalMs = (this.leaderTtl * 1000) / 2;

        this.renewalInterval = setInterval(async () => {
            try {
                const stillLeader = await this.renewLock();
                if (!stillLeader) {
                    console.warn(`${TAG} lost leadership, stopping renewal`);
                    this.stopRenewal();
                }
            } catch (err) {
                console.error(`${TAG} lock renewal failed:`, err);
            }
        }, renewalMs);
    }

    private stopRenewal(): void {
        if (this.renewalInterval) {
            clearInterval(this.renewalInterval);
            this.renewalInterval = null;
        }
    }

    private async renewLock(): Promise<boolean> {
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("expire", KEYS[1], ARGV[2])
            else
                return 0
            end
        `;
        const result = await this.redis.eval(script, 1, LEADER_KEY, this.workerId, this.leaderTtl);
        return result === 1;
    }
}