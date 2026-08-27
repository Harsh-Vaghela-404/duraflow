import path from 'path';

const TAG = '[load-workflows]';

// Importing a workflow file runs its top-level workflow() calls, which register
// the handler and its compensations. Needs to run in both worker threads (to
// execute the workflow) and the main thread (rollback resolves compensations
// by name too).
export function loadWorkflows(raw: string | undefined = process.env.DURAFLOW_WORKFLOWS): void {
    const paths =
        raw
            ?.split(',')
            .map((p) => p.trim())
            .filter(Boolean) ?? [];

    if (paths.length === 0) {
        console.log(`${TAG} no DURAFLOW_WORKFLOWS set - no user workflows loaded`);
        return;
    }

    for (const p of paths) {
        try {
            const resolved = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require(resolved);
            console.log(`${TAG} loaded workflows from: ${resolved}`);
        } catch (err) {
            console.error(`${TAG} failed to load workflow: ${p}`, err);
        }
    }
}
