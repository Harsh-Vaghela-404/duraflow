import Redis from 'ioredis';
import { RATE_LIMIT_KEY_PREFIX } from '../constants/lock_ids';
import { RateLimitTimeoutError } from '../errors/rate-limit-timeout.error';

export class RateLimiter {
    private sha: string | null = null;
    constructor(
        private readonly redis: Redis,
        private config: { capacity: number; ratePerMinute: number; ttlSeconds: number },
    ) {}

    async init(): Promise<void> {
        const checkLimits = `
        local key = KEYS[1]
        local requested = tonumber(ARGV[1])
        local capacity = tonumber(ARGV[2])
        local rate = tonumber(ARGV[3])
        local ttl = tonumber(ARGV[4])

        local time = redis.call('TIME')
        local seconds = tonumber(time[1])
        local microseconds = tonumber(time[2])

        local now = seconds * 1000 + math.floor(microseconds/1000)

        local data = redis.call('HMGET', key, 'tokens', 'ts')
        local tokens = tonumber(data[1])
        local ts = tonumber(data[2])

        if tokens == nil then
            tokens = capacity
            ts = now
        end

        local elapsed = math.max(0, now - ts)
        local refilled = math.min(capacity, tokens + elapsed * rate)

        if refilled >= requested then
            local remaining = refilled - requested
            redis.call('HMSET', key, 'tokens', remaining, 'ts', now)
            redis.call('EXPIRE', key, ttl)
            return {1, math.floor(remaining)}
        else
            redis.call('HMSET', key, 'tokens', refilled, 'ts', now)
            redis.call('EXPIRE', key, ttl)
            return {0, math.floor(refilled)}
        end
        `;

        this.sha = (await this.redis.script('LOAD', checkLimits)) as string;
    }

    private toRedisKey(key: string): string {
        return `${RATE_LIMIT_KEY_PREFIX}:${key}`;
    }

    async acquire(key: string, tokens: number) {
        if (!this.sha) {
            throw new Error('RateLimiter not initiated - call init() first');
        }

        const result = (await this.redis.evalsha(
            this.sha,
            1,
            this.toRedisKey(key),
            tokens,
            this.config.capacity,
            this.config.ratePerMinute / 60_000,
            this.config.ttlSeconds,
        )) as [number, number];

        return result[0] ?? false;
    }

    async waitForToken(key: string, timeoutMs = 30000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const allowed = await this.acquire(key, 1);
            if (allowed) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new RateLimitTimeoutError(key, timeoutMs);
    }

    async getRemaining(key: string): Promise<number> {
        if (!this.sha) throw new Error('RateLimiter not initiated - call init() first');
        const result = (await this.redis.evalsha(
            this.sha,
            1,
            this.toRedisKey(key),
            0,
            this.config.capacity,
            this.config.ratePerMinute / 60000,
            this.config.ttlSeconds,
        )) as [number, number];
        return result[1] ?? 0;
    }

    async reset(key: string): Promise<boolean> {
        if (!this.sha) throw new Error('RateLimiter not initiated - call init() first');
        await this.redis.del(this.toRedisKey(key));
        return true;
    }
}
