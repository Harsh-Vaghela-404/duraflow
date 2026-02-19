export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function waitUntil(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs = 5000,
    intervalMs = 100
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate()) return;
        await sleep(intervalMs);
    }
    throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}
