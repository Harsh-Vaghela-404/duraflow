import { Redis } from 'ioredis';

const LEADER_KEY = 'duraflow:reaper:leader';
const LEADER_TTL_SECONDS = parseInt(process.env.LEADER_TTL_SECONDS);

export class LeaderElector {
    private workerId: string;
    private renewalInterval: NodeJS.Timeout | null = null;

    constructor(
        private redis: Redis,
        workerId?: string
    ) {
        this.workerId = workerId || `worker-${process.pid}-${Date.now()}`;
    }

    async tryBecomeLeader(): Promise<boolean> {
        // SETNX with TTL - atomic operation
        const result = await this.redis.set(
            LEADER_KEY,
            this.workerId,
            'EX', LEADER_TTL_SECONDS,
            'NX'
        );

        if (result === 'OK') {
            this.startRenewal();
            return true;
        }

        // Check if we're already the leader (re-election after restart)
        const currentLeader = await this.redis.get(LEADER_KEY);
        return currentLeader === this.workerId;
    }

    async releaseLeadership(): Promise<void> {
        this.stopRenewal();

        // Only release if we're the current leader (Lua script for atomicity)
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;

        await this.redis.eval(script, 1, LEADER_KEY, this.workerId);
    }

    async isLeader(): Promise<boolean> {
        const currentLeader = await this.redis.get(LEADER_KEY);
        return currentLeader === this.workerId;
    }

    private startRenewal(): void {
        // Renew lock at half the TTL interval
        const renewalMs = (LEADER_TTL_SECONDS * 1000) / 2;

        this.renewalInterval = setInterval(async () => {
            try {
                const stillLeader = await this.renewLock();
                if (!stillLeader) {
                    this.stopRenewal();
                }
            } catch (error) {
                console.error('Leader lock renewal failed:', error);
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
        // Only extend TTL if we're still the leader
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("expire", KEYS[1], ARGV[2])
            else
                return 0
            end
        `;

        const result = await this.redis.eval(
            script, 1,
            LEADER_KEY,
            this.workerId,
            LEADER_TTL_SECONDS
        );

        return result === 1;
    }
}