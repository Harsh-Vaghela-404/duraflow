export interface ApiRateLimitConfig {
    name: string;
    rpm: number;
    tpm: number;
    capacity: number;
    ttlSeconds: number;
}

export const DEFAULT_API_LIMITS: Record<string, ApiRateLimitConfig> = {
    openai: { name: 'openai', rpm: 10_000, tpm: 2_000_000, capacity: 200, ttlSeconds: 300 },
    anthropic: { name: 'anthropic', rpm: 40_000, tpm: 5_000_000, capacity: 500, ttlSeconds: 300 },
    google: { name: 'google', rpm: 60_000, tpm: 4_000_000, capacity: 500, ttlSeconds: 300 },
    cohere: { name: 'cohere', rpm: 10_000, tpm: 1_000_000, capacity: 100, ttlSeconds: 300 },
};

const FALLBACK_LIMIT: Omit<ApiRateLimitConfig, 'name'> = {
    rpm: 60,
    tpm: 60_000,
    capacity: 10,
    ttlSeconds: 300,
};

export function getApiRateLimitConfig(
    api: string,
    overrides?: Partial<Omit<ApiRateLimitConfig, 'name'>>,
): ApiRateLimitConfig {
    const key = api.toLowerCase().trim();
    if (!key) throw new Error('api name must be a non-empty string');

    const envKey = key.toUpperCase();
    const base = DEFAULT_API_LIMITS[key] ?? { ...FALLBACK_LIMIT, name: key };

    const rpm =
        overrides?.rpm ?? parseInt(process.env[`RATE_LIMIT_${envKey}_RPM`] ?? String(base.rpm), 10);
    const tpm =
        overrides?.tpm ?? parseInt(process.env[`RATE_LIMIT_${envKey}_TPM`] ?? String(base.tpm), 10);
    const capacity =
        overrides?.capacity ??
        parseInt(process.env[`RATE_LIMIT_${envKey}_CAPACITY`] ?? String(base.capacity), 10);
    const ttlSeconds =
        overrides?.ttlSeconds ??
        parseInt(process.env[`RATE_LIMIT_${envKey}_TTL`] ?? String(base.ttlSeconds), 10);

    if (!Number.isFinite(rpm) || rpm <= 0)
        throw new Error(`RATE_LIMIT_${envKey}_RPM must be a positive integer, got: ${rpm}`);
    if (!Number.isFinite(tpm) || tpm <= 0)
        throw new Error(`RATE_LIMIT_${envKey}_TPM must be a positive integer, got: ${tpm}`);
    if (!Number.isFinite(capacity) || capacity <= 0)
        throw new Error(
            `RATE_LIMIT_${envKey}_CAPACITY must be a positive integer, got: ${capacity}`,
        );
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)
        throw new Error(`RATE_LIMIT_${envKey}_TTL must be a positive integer, got: ${ttlSeconds}`);

    return { name: key, rpm, tpm, capacity, ttlSeconds };
}
