import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { waitUntil, sleep } from "../helpers/poll";
import { createTestPool, closePool, clearTables } from "../helpers/db";

const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/proto/agent.service.proto",
);
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const agentProto = protoDescriptor.duraflow;

function createClient(port: number): any {
  return new agentProto.AgentService(
    `localhost:${port}`,
    grpc.credentials.createInsecure(),
  );
}

describe("E2E gRPC", () => {
  let engine: ChildProcess;
  let client: any;
  const PORT = 50100; // Use different port to avoid conflicts
  // Hoisted so afterAll can reference it for pkill cleanup
  const enginePath = path.resolve(__dirname, "../../src/index.ts");

  beforeAll(async () => {
    // Clear DB first
    const pool = createTestPool();
    await clearTables(pool);
    await closePool(pool);

    // Spawn engine
    engine = spawn("npx", ["tsx", enginePath], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DURAFLOW_WORKFLOWS: path.resolve(
          __dirname,
          "../workflows/test-workflows.ts",
        ),
        DATABASE_URL:
          process.env.DATABASE_URL ||
          "postgresql://duraflow:duraflow@localhost:5432/duraflow",
      },
      stdio: "pipe",
      shell: true,
      detached: true, // New process group so the whole tree can be killed cleanly
    });

    // Wait for port to be ready
    await waitUntil(
      async () => {
        return new Promise((resolve) => {
          const c = createClient(PORT);
          c.waitForReady(Date.now() + 1000, (err: Error | null) => {
            c.close();
            resolve(!err);
          });
        });
      },
      20000,
      500,
    );

    client = createClient(PORT);
  }, 30000);

  afterAll(async () => {
    client?.close();
    if (engine?.pid && !engine.killed) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(engine.pid), "/f", "/t"]);
      } else {
        // Kill the entire process group (shell + npx + tsx + node engine).
        // SIGKILL is used because the engine has a SIGTERM graceful-shutdown handler
        // that takes several seconds. SIGKILL is unblockable so every process in the
        // group (shell, npx, tsx, node) dies immediately, preventing the orphaned
        // Poller from dequeuing tasks in subsequent tests.
        // detached:true gave the shell its own PGID equal to engine.pid.
        try {
          process.kill(-engine.pid, "SIGKILL");
        } catch {
          engine.kill("SIGKILL");
        }
        // npm exec spawns its child processes (sh → tsx → node) in the parent's
        // process group rather than the detached shell's group, so the process-group
        // kill above may leave the actual engine node process alive. Kill any
        // surviving process whose argv contains the unique engine entry-point path.
        try {
          execSync(`pkill -9 -f "${enginePath}" 2>/dev/null || true`);
        } catch {
          // pkill not available or no matching processes — ignore
        }
      }
      // Wait for the shell process to actually exit before moving on
      await new Promise<void>((resolve) => {
        engine.once("exit", resolve);
        setTimeout(resolve, 5000); // fallback in case exit event never fires
      });
    }
  });

  it("submits a task via gRPC and polls until completion", async () => {
    // 1. Submit
    const submitRes: any = await new Promise((resolve, reject) => {
      client.submitTask(
        {
          workflow_name: "simple-wf",
          input: Buffer.from(JSON.stringify({ e2e: true })),
        },
        (err: any, res: any) => {
          if (err) reject(err);
          else resolve(res);
        },
      );
    });

    expect(submitRes.task_id).toBeDefined();
    const taskId = submitRes.task_id;

    // 2. Poll status
    await waitUntil(
      async () => {
        const statusRes: any = await new Promise((resolve, reject) => {
          client.getTaskStatus({ task_id: taskId }, (err: any, res: any) => {
            if (err) reject(err);
            else resolve(res);
          });
        });
        return statusRes.status === "COMPLETED";
      },
      15000,
      200,
    );

    // 3. Verify output
    const finalStatus: any = await new Promise((resolve, reject) => {
      client.getTaskStatus({ task_id: taskId }, (err: any, res: any) => {
        if (err) reject(err);
        else resolve(res);
      });
    });

    expect(finalStatus.status).toBe("COMPLETED");
    // gRPC returns bytes buffer for output/error because they are `bytes` in proto?
    // Wait, proto defines output as `bytes`.
    // AgentService implementation: output: task.output ? Buffer.from(JSON.stringify(task.output)) : Buffer.from('')

    const outputJson = JSON.parse(finalStatus.output.toString());
    expect(outputJson).toEqual({ result: { processed: { e2e: true } } });
  });
});
