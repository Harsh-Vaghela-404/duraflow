import type { MessagePort } from 'worker_threads';
import { randomUUID } from 'crypto';
import { IPC_TIMEOUT_MS } from '../constants/engine';

const TAG = '[ipc-client]';

export type IPCMessageType =
  | 'STEP_FIND'
  | 'STEP_CREATE_OR_FIND'
  | 'STEP_COMPLETE'
  | 'STEP_FAIL'
  | 'STEP_INCREMENT'
  | 'RATE_LIMIT_ACQUIRE';

export interface IPCRequest {
  id: string;
  type: IPCMessageType;
  payload: Record<string, unknown>;
}

export interface IPCResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: { message: string; name: string };
}

export class IPCClient {
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly port: MessagePort,
    private readonly timeoutMs: number = IPC_TIMEOUT_MS,
  ) {
    this.port.on('message', (msg: IPCResponse) => this.handleResponse(msg));
  }

  private handleResponse(msg: IPCResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(msg.id);
    if (msg.success) {
      pending.resolve(msg.data);
    } else {
      const err = new Error(msg.error?.message ?? 'IPC error');
      err.name = msg.error?.name ?? 'Error';
      pending.reject(err);
    }
  }

  send<T>(type: IPCMessageType, payload: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC ${type} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      timeout.unref();

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeout,
      });
      this.port.postMessage({ id, type, payload } as IPCRequest);
    });
  }

  close(): void {
    for (const [, { timeout, reject }] of this.pending) {
      clearTimeout(timeout);
      reject(new Error(`${TAG} client closed`));
    }
    this.pending.clear();
    this.port.close();
  }
}
