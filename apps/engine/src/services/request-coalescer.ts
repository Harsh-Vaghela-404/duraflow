import crypto, { randomUUID } from 'crypto';

const TAG = '[request-coalescer]';

export class RequestCoalescer {
    private pending = new Map<string, Promise<unknown>>();
    private coalesced = 0;

    private hash(api: string, input: unknown): string {
        try {
            return crypto
                .createHash('sha256')
                .update(api + JSON.stringify(input))
                .digest('hex');
        } catch (err) {
            console.warn(`${TAG} hash failed for api '${api}', bypassing coalescing:`, err);
            return randomUUID();
        }
    }

    coalesce<T>(api: string, input: unknown, fn: () => Promise<T>) {
        const key = this.hash(api, input);

        const existing = this.pending.get(key);
        if (existing) {
            this.coalesced += 1;
            return existing as Promise<T>;
        }

        const promise = fn().finally(() => {
            setTimeout(() => this.pending.delete(key), 100); // 100ms TTL
        });

        this.pending.set(key, promise);
        return promise;
    }

    get coalescedCount() {
        return this.coalesced;
    }
}
