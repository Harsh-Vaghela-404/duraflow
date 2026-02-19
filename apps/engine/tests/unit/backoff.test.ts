import { calculateBackOff } from '../../src/utils/backoff';

describe('calculateBackOff', () => {
    it('returns ~1000ms for attempt 1 (default)', () => {
        const delay = calculateBackOff(1);
        expect(delay).toBeGreaterThanOrEqual(900);
        expect(delay).toBeLessThanOrEqual(1100);
    });

    it('returns ~4000ms for attempt 2 (default base 4)', () => {
        const delay = calculateBackOff(2);
        expect(delay).toBeGreaterThanOrEqual(3600);
        expect(delay).toBeLessThanOrEqual(4400);
    });

    it('caps at maxInterval', () => {
        const delay = calculateBackOff(10, 1000, 4, 5000);
        expect(delay).toBeGreaterThanOrEqual(4500); // 5000 ± 10% jitter
        expect(delay).toBeLessThanOrEqual(5500);
    });
});
