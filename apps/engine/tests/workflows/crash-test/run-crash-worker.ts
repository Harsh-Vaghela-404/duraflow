// This script is spawned by crash-recovery.test.ts
// It registers the crash workflow and starts the engine.

console.log('[crash-worker] initializing...');

// 1. Register the workflow (must happen before engine starts handling tasks)
import './crash-test.workflow';

// 2. Start the engine (starts Poller, Reaper, etc.)
// index.ts executes main() automatically on import
import '../../src/index';

console.log('[crash-worker] engine started with crash-test workflow registered');
