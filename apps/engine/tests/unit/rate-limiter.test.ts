import Redis from 'ioredis';
import { RateLimiter } from '../../src/services/rate-limiter';
import { RateLimitTimeoutError } from '../../src/errors/rate-limit-timeout.error';
import { sleep } from '../helpers/poll';

const CONFIG = { capacity: 10, ratePerMinute: 600, ttlSeconds: 60 };
const PREFIXED_KEY = 'duraflow:rl:openai';

function makeRedisMock(overrides: Partial<Record<string, jest.Mock>> = {}): jest.Mocked<Redis> {
    return {
        script: jest.fn().mockResolvedValue('abc123'),
        evalsha: jest.fn().mockResolvedValue([1, 9]),
        del: jest.fn().mockResolvedValue(1),
        ...overrides,
    } as unknown as jest.Mocked<Redis>;
}

describe('RateLimiter (unit)', () => {
    describe('before init()', () => {
        it('acquire() throws if init() was not called', async () => {
            const limiter = new RateLimiter(makeRedisMock(), CONFIG);
            await expect(limiter.acquire('openai', 1)).rejects.toThrow('RateLimiter not initiated');
        });

        it('getRemaining() throws if init() was not called', async () => {
            const limiter = new RateLimiter(makeRedisMock(), CONFIG);
            await expect(limiter.getRemaining('openai')).rejects.toThrow('RateLimiter not initiated');
        });

        it('reset() throws if init() was not called', async () => {
            const limiter = new RateLimiter(makeRedisMock(), CONFIG);
            await expect(limiter.reset('openai')).rejects.toThrow('RateLimiter not initiated');
        });
    });

    describe('init()', () => {
        it('loads the Lua script into Redis and stores the SHA', async () => {
            const redis = makeRedisMock();
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            expect(redis.script).toHaveBeenCalledWith('LOAD', expect.any(String));
        });
    });

    describe('acquire()', () => {
        it('returns truthy when tokens are available', async () => {
            const redis = makeRedisMock({ evalsha: jest.fn().mockResolvedValue([1, 9]) });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            const result = await limiter.acquire('openai', 1);
            expect(result).toBeTruthy();
        });

        it('returns falsy when tokens are exhausted', async () => {
            const redis = makeRedisMock({ evalsha: jest.fn().mockResolvedValue([0, 0]) });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            const result = await limiter.acquire('openai', 1);
            expect(result).toBeFalsy();
        });

        it('calls evalsha with the correct namespaced key', async () => {
            const redis = makeRedisMock();
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            await limiter.acquire('openai', 1);
            expect(redis.evalsha).toHaveBeenCalledWith(
                'abc123',
                1,
                PREFIXED_KEY,
                1,           // tokens requested
                10,          // capacity
                expect.any(Number), // rate per ms
                60,          // ttl
            );
        });

        it('propagates Redis errors without swallowing them', async () => {
            const redis = makeRedisMock({
                evalsha: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
            });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            await expect(limiter.acquire('openai', 1)).rejects.toThrow('Redis connection lost');
        });
    });

    describe('getRemaining()', () => {
        it('returns available token count from Redis', async () => {
            const redis = makeRedisMock({ evalsha: jest.fn().mockResolvedValue([1, 7]) });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            const remaining = await limiter.getRemaining('openai');
            expect(remaining).toBe(7);
        });

        it('calls evalsha with tokens=0 so no tokens are consumed', async () => {
            const redis = makeRedisMock({ evalsha: jest.fn().mockResolvedValue([1, 10]) });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            await limiter.getRemaining('openai');
            expect(redis.evalsha).toHaveBeenCalledWith(
                'abc123',
                1,
                PREFIXED_KEY,
                0,           // tokens=0 means read-only
                expect.any(Number),
                expect.any(Number),
                expect.any(Number),
            );
        });

        it('returns 0 when evalsha returns null for remaining', async () => {
            const redis = makeRedisMock({ evalsha: jest.fn().mockResolvedValue([1, null]) });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            const remaining = await limiter.getRemaining('openai');
            expect(remaining).toBe(0);
        });
    });

    describe('reset()', () => {
        it('deletes the Redis key for the given API', async () => {
            const redis = makeRedisMock();
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            const result = await limiter.reset('openai');
            expect(result).toBe(true);
            expect(redis.del).toHaveBeenCalledWith(PREFIXED_KEY);
        });
    });

    describe('waitForToken()', () => {
        it('resolves immediately when a token is available on the first poll', async () => {
            const redis = makeRedisMock({ evalsha: jest.fn().mockResolvedValue([1, 9]) });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            await expect(limiter.waitForToken('openai', 1000)).resolves.toBeUndefined();
        });

        it('retries polling until a token becomes available', async () => {
            // First two calls: denied; third call: allowed
            const evalsha = jest.fn()
                .mockResolvedValueOnce([1, 'sha-load']) // script LOAD (handled by init)
                .mockResolvedValueOnce([0, 0])
                .mockResolvedValueOnce([0, 0])
                .mockResolvedValueOnce([1, 1]);

            const redis = makeRedisMock({ evalsha });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            await expect(limiter.waitForToken('openai', 2000)).resolves.toBeUndefined();
        });

        it('throws RateLimitTimeoutError when timeout is exceeded', async () => {
            const redis = makeRedisMock({ evalsha: jest.fn().mockResolvedValue([0, 0]) });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            await expect(limiter.waitForToken('openai', 150)).rejects.toThrow(RateLimitTimeoutError);
        });

        it('includes the API key and timeout in the error message', async () => {
            const redis = makeRedisMock({ evalsha: jest.fn().mockResolvedValue([0, 0]) });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            await expect(limiter.waitForToken('openai', 150)).rejects.toThrow("openai");
        });

        it('resolves without consuming extra tokens beyond one', async () => {
            const evalsha = jest.fn()
                .mockResolvedValueOnce([0, 0])  // denied
                .mockResolvedValueOnce([1, 9]); // allowed

            const redis = makeRedisMock({ evalsha });
            const limiter = new RateLimiter(redis, CONFIG);
            await limiter.init();
            await limiter.waitForToken('openai', 1000);
            // evalsha called exactly twice: once denied, once allowed
            expect(redis.evalsha).toHaveBeenCalledTimes(2);
        });
    });
});
