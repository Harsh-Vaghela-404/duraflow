export class RateLimitTimeoutError extends Error {
    constructor(api: string, timeoutMs: number) {
        super(`Rate limit timeout after ${timeoutMs}ms for API '${api}'`);
        this.name = 'RateLimitTimeoutError';
    }
}
