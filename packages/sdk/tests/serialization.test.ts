import { serialize, deserialize, SerializationError } from '../src/utils/serialization';

describe('Serialization Utils', () => {
    test('should serialize and deserialize primitives', () => {
        expect(deserialize(serialize(123))).toBe(123);
        expect(deserialize(serialize('hello'))).toBe('hello');
        expect(deserialize(serialize(true))).toBe(true);
        expect(deserialize(serialize(null))).toBe(null);
    });

    test('should serialize and deserialize complex types', () => {
        const date = new Date();
        const map = new Map([['a', 1], ['b', 2]]);
        const set = new Set([1, 2, 3]);
        const error = new Error('test error');

        const input = { date, map, set, error };
        const output = deserialize<typeof input>(serialize(input));

        expect(output?.date).toBeInstanceOf(Date);
        expect(output?.date.toISOString()).toBe(date.toISOString());

        expect(output?.map).toBeInstanceOf(Map);
        expect(output?.map.get('a')).toBe(1);

        expect(output?.set).toBeInstanceOf(Set);
        expect(output?.set.has(1)).toBe(true);

        expect(output?.error).toBeInstanceOf(Error);
        expect(output?.error.message).toBe('test error');
    });

    test('should enforce 1MB size limit', () => {
        const largeString = 'a'.repeat(1024 * 1024 + 1); // > 1MB
        expect(() => serialize(largeString)).toThrow(SerializationError);
        expect(() => serialize(largeString)).toThrow(/Payload size exceeds maximum limit/);
    });

    test('should handle undefined', () => {
        expect(serialize(undefined)).toBe('');
        expect(deserialize('')).toBeUndefined();
    });
});
