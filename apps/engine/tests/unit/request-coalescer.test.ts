import { RequestCoalescer } from '../../src/services/request-coalescer';
import { sleep } from '../helpers/poll';

describe('RequestCoalescer (unit)', () => {
    let coalescer: RequestCoalescer;

    beforeEach(() => {
        coalescer = new RequestCoalescer();
    });

    describe('coalesce()', () => {
        it('calls the factory function once for the first request', async () => {
            const fn = jest.fn().mockResolvedValue('result');
            await coalescer.coalesce('openai', { prompt: 'hello' }, fn);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('returns the same promise for identical concurrent requests', async () => {
            let resolveRequest: (v: string) => void;
            const fn = jest.fn().mockReturnValue(
                new Promise<string>((resolve) => { resolveRequest = resolve; }),
            );

            const p1 = coalescer.coalesce('openai', { prompt: 'hello' }, fn);
            const p2 = coalescer.coalesce('openai', { prompt: 'hello' }, fn);

            resolveRequest!('result');
            const [r1, r2] = await Promise.all([p1, p2]);

            expect(r1).toBe('result');
            expect(r2).toBe('result');
            // only one real call made
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('increments coalescedCount for each coalesced duplicate', async () => {
            let resolveRequest: (v: string) => void;
            const fn = jest.fn().mockReturnValue(
                new Promise<string>((resolve) => { resolveRequest = resolve; }),
            );

            coalescer.coalesce('openai', { prompt: 'hello' }, fn);
            coalescer.coalesce('openai', { prompt: 'hello' }, fn);
            coalescer.coalesce('openai', { prompt: 'hello' }, fn);

            resolveRequest!('result');
            expect(coalescer.coalescedCount).toBe(2); // 2 duplicates, 1 original
        });

        it('does not coalesce requests for different APIs', async () => {
            const fn = jest.fn().mockResolvedValue('result');
            await coalescer.coalesce('openai', { prompt: 'hello' }, fn);
            await coalescer.coalesce('anthropic', { prompt: 'hello' }, fn);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('does not coalesce requests with different inputs for the same API', async () => {
            const fn = jest.fn().mockResolvedValue('result');
            await coalescer.coalesce('openai', { prompt: 'hello' }, fn);
            await coalescer.coalesce('openai', { prompt: 'world' }, fn);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('allows a second independent request after the first resolves and TTL expires', async () => {
            const fn = jest.fn().mockResolvedValue('result');
            await coalescer.coalesce('openai', { prompt: 'hello' }, fn);

            // wait for the 100ms post-resolve TTL to clear the pending map
            await sleep(200);

            await coalescer.coalesce('openai', { prompt: 'hello' }, fn);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('all callers receive the correct result even when coalesced', async () => {
            let resolveRequest: (v: { embedding: number[] }) => void;
            const fn = jest.fn().mockReturnValue(
                new Promise<{ embedding: number[] }>((resolve) => { resolveRequest = resolve; }),
            );

            const p1 = coalescer.coalesce('openai', { text: 'embed me' }, fn);
            const p2 = coalescer.coalesce('openai', { text: 'embed me' }, fn);
            const p3 = coalescer.coalesce('openai', { text: 'embed me' }, fn);

            const expected = { embedding: [0.1, 0.2, 0.3] };
            resolveRequest!(expected);

            const results = await Promise.all([p1, p2, p3]);
            for (const r of results) {
                expect(r).toEqual(expected);
            }
        });

        it('handles circular-reference inputs gracefully by bypassing coalescing', async () => {
            const circular: Record<string, unknown> = {};
            circular['self'] = circular;

            const fn = jest.fn().mockResolvedValue('safe');

            // Both calls with circular input fall back to unique UUID keys — no coalescing
            const r1 = await coalescer.coalesce('openai', circular, fn);
            const r2 = await coalescer.coalesce('openai', circular, fn);

            expect(r1).toBe('safe');
            expect(r2).toBe('safe');
            // Two separate calls because hash failed and randomUUID() was used each time
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('propagates rejections to all coalesced callers', async () => {
            let rejectRequest: (err: Error) => void;
            const fn = jest.fn().mockReturnValue(
                new Promise<string>((_, reject) => { rejectRequest = reject; }),
            );

            const p1 = coalescer.coalesce('openai', { prompt: 'fail' }, fn);
            const p2 = coalescer.coalesce('openai', { prompt: 'fail' }, fn);

            rejectRequest!(new Error('API error'));

            await expect(p1).rejects.toThrow('API error');
            await expect(p2).rejects.toThrow('API error');
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe('coalescedCount', () => {
        it('starts at zero', () => {
            expect(coalescer.coalescedCount).toBe(0);
        });

        it('only counts coalesced duplicates, not the original call', async () => {
            const fn = jest.fn().mockResolvedValue('x');
            await coalescer.coalesce('a', {}, fn);
            expect(coalescer.coalescedCount).toBe(0);
        });
    });
});
