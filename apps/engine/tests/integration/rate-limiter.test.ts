import Redis from 'ioredis';
import { RateLimiter } from '../../src/services/rate-limiter';
import { RateLimitTimeoutError } from '../../src/errors/rate-limit-timeout.error';
import { createTestRedis } from '../helpers/db';
import { sleep } from '../helpers/poll';

// capacity=5, rate=300/min = 5/sec → 1 token refills every 200ms
const CONFIG = { capacity: 5, ratePerMinute: 300, ttlSeconds: 60 };

// Unique key per test run to avoid cross-test pollution when flushall is not called
function testKey(label: string) {
    return `test-${label}-${Date.now()}`;
}

describe('RateLimiter (integration)', () => {
    let redis: Redis;
    let limiter: RateLimiter;

    beforeAll(async () => {
        redis = createTestRedis();
        await redis.connect();
        limiter = new RateLimiter(redis, CONFIG);
        await limiter.init();
    });

    afterAll(async () => {
        await redis.quit();
    });

    describe('token bucket - basic behavior', () => {
        it('allows requests up to capacity and denies beyond it', async () => {
            const key = testKey('basic');

            const results: number[] = [];
            for (let i = 0; i < 7; i++) {
                results.push(await limiter.acquire(key, 1));
            }

            const allowed = results.filter((r) => r === 1).length;
            const denied = results.filter((r) => r === 0).length;

            expect(allowed).toBe(5); // capacity
            expect(denied).toBe(2); // over capacity
        });

        it('refills tokens over time', async () => {
            const key = testKey('refill');

            // exhaust all tokens
            for (let i = 0; i < 5; i++) {
                await limiter.acquire(key, 1);
            }

            // next immediate call is denied
            expect(await limiter.acquire(key, 1)).toBe(0);

            // wait 250ms - should have ~1.25 tokens refilled at 5/sec
            await sleep(250);
            expect(await limiter.acquire(key, 1)).toBe(1);
        });

        it('getRemaining returns correct count without consuming tokens', async () => {
            const key = testKey('remaining');

            // consume 2 of 5
            await limiter.acquire(key, 1);
            await limiter.acquire(key, 1);

            const remaining = await limiter.getRemaining(key);
            // 3 remaining + refill during the 2 calls (very small, floored to int by Lua)
            expect(remaining).toBeGreaterThanOrEqual(3);
            expect(remaining).toBeLessThanOrEqual(5);

            // getRemaining does not consume - another call should not reduce count further
            const remainingAgain = await limiter.getRemaining(key);
            expect(remainingAgain).toBeGreaterThanOrEqual(remaining - 1); // allow for tiny refill delta
        });

        it('reset() clears the bucket so next acquire starts fresh', async () => {
            const key = testKey('reset');

            // exhaust all tokens
            for (let i = 0; i < 5; i++) {
                await limiter.acquire(key, 1);
            }
            expect(await limiter.acquire(key, 1)).toBe(0);

            // reset and verify bucket is full again
            await limiter.reset(key);
            expect(await limiter.acquire(key, 1)).toBe(1);
        });
    });

    describe('multi-key isolation', () => {
        it('different API keys do not share token pools', async () => {
            const keyA = testKey('isolation-a');
            const keyB = testKey('isolation-b');

            // exhaust keyA
            for (let i = 0; i < 5; i++) {
                await limiter.acquire(keyA, 1);
            }
            expect(await limiter.acquire(keyA, 1)).toBe(0);

            // keyB should still have full capacity
            expect(await limiter.acquire(keyB, 1)).toBe(1);
        });
    });

    describe('waitForToken()', () => {
        it('resolves immediately when tokens are available', async () => {
            const key = testKey('wait-available');
            const start = Date.now();
            await limiter.waitForToken(key, 2000);
            expect(Date.now() - start).toBeLessThan(200);
        });

        it('waits and resolves once a token refills', async () => {
            const key = testKey('wait-refill');

            // exhaust all tokens
            for (let i = 0; i < 5; i++) {
                await limiter.acquire(key, 1);
            }

            // waitForToken should resolve within ~1s as token refills at 5/sec
            const start = Date.now();
            await expect(limiter.waitForToken(key, 3000)).resolves.toBeUndefined();
            const elapsed = Date.now() - start;

            // should not have resolved instantly (bucket is empty) but well within timeout
            expect(elapsed).toBeGreaterThan(50);
            expect(elapsed).toBeLessThan(2000);
        });

        it('throws RateLimitTimeoutError when timeout expires before token available', async () => {
            // Use a limiter with very slow refill: 6/min = 0.1/sec → 1 token per 10s
            const slowConfig = { capacity: 1, ratePerMinute: 6, ttlSeconds: 60 };
            const slowLimiter = new RateLimiter(redis, slowConfig);
            await slowLimiter.init();

            const key = testKey('wait-timeout');

            // exhaust the single token
            await slowLimiter.acquire(key, 1);

            // timeout of 300ms - refill at 0.1/sec means 10s before next token
            await expect(slowLimiter.waitForToken(key, 300)).rejects.toThrow(RateLimitTimeoutError);
        });

        it('handles concurrent waitForToken callers - all resolve', async () => {
            // fresh key - capacity=5, so 5 concurrent callers should all resolve immediately
            const key = testKey('wait-concurrent');

            const promises = Array.from({ length: 5 }, () => limiter.waitForToken(key, 2000));
            await expect(Promise.all(promises)).resolves.toBeDefined();
        });
    });

    describe('concurrent acquire() under load', () => {
        it('never exceeds capacity across concurrent callers', async () => {
            const key = testKey('concurrent-load');

            // fire 20 concurrent acquires against a capacity-5 bucket
            const results = await Promise.all(
                Array.from({ length: 20 }, () => limiter.acquire(key, 1)),
            );

            const allowed = results.filter((r) => r === 1).length;
            // Lua script is atomic - at most capacity tokens can be granted
            expect(allowed).toBeLessThanOrEqual(5);
        });
    });
});
