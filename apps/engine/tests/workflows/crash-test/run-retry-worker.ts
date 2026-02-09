import path from 'path';
async function start() {
    const workflowPath = path.join(__dirname, 'retry-workflow.ts');
    process.env.DURAFLOW_WORKFLOWS = workflowPath;
    console.log(`[run-worker] DURAFLOW_WORKFLOWS set to: ${workflowPath}`);

    await import('./retry-workflow');

    await import('../../../src/index');
}

start().catch(err => {
    console.error('[run-worker] Failed to start:', err);
    process.exit(1);
});
