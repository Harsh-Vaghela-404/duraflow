import path from 'path';

const TAG = '[load-workflows]';

// Loads the user workflow modules named in DURAFLOW_WORKFLOWS (comma-separated
// paths). Importing a workflow module runs its top-level `workflow(...)` calls,
// which register the workflow handler AND its compensations (see the SDK's
// Compensation contract).
//
// This MUST run in every process that needs those registrations:
//   - each Piscina worker thread (to run the workflow), and
//   - the engine main thread (so the RollbackOrchestrator can resolve
//     compensations by name at rollback time).
//
// Paths are resolved relative to process.cwd(), matching how the engine is
// launched (`tsx src/index.ts` from apps/engine).
export function loadWorkflows(raw: string | undefined = process.env.DURAFLOW_WORKFLOWS): void {
    const paths = raw?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];

    if (paths.length === 0) {
        console.log(`${TAG} no DURAFLOW_WORKFLOWS set — no user workflows loaded`);
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
