import superjson from 'superjson';

const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

export class SerializationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SerializationError';
    }
}

export function serialize(value: unknown): string {
    if (value === undefined) return '';

    try {
        const stringified = superjson.stringify(value);

        if (Buffer.byteLength(stringified) > MAX_PAYLOAD_SIZE) {
            throw new SerializationError(
                `Payload size exceeds maximum limit of 1MB. Current size: ${(Buffer.byteLength(stringified) / 1024 / 1024).toFixed(2)}MB`
            );
        }

        return stringified;
    } catch (err) {
        if (err instanceof SerializationError) throw err;
        throw new SerializationError(`Failed to serialize data: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function deserialize<T>(value: string | null | undefined): T | undefined {
    if (!value || value.trim() === '') return undefined;

    try {
        return superjson.parse<T>(value);
    } catch (err) {
        throw new SerializationError(`Failed to deserialize data: ${err instanceof Error ? err.message : String(err)}`);
    }
}
