import { spawn, ChildProcess } from "child_process";
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

  beforeAll(async () => {
    // Clear DB first
    const pool = createTestPool();
    await clearTables(pool);
    await closePool(pool);

    // Spawn engine
    const enginePath = path.resolve(__dirname, "../../src/index.ts");
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
      stdio: "pipe", // Capture stdout/stderr
      shell: true, // Needed on Windows
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
    if (engine && !engine.killed) {
      // Force kill to ensure process stops
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(engine.pid), "/f", "/t"]);
      } else {
        engine.kill("SIGTERM");
      }
    }
    // Give it a moment to release ports
    await sleep(2000);
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
