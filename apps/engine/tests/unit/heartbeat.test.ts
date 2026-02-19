import { HeartbeatService } from "../../src/services/heartbeat.service";
import { sleep } from "../helpers/poll";

describe("HeartbeatService", () => {
  let mockRepo: any;
  let heartbeat: HeartbeatService;

  beforeEach(() => {
    mockRepo = {
      updateHeartbeat: jest.fn().mockResolvedValue(undefined),
    };
    heartbeat = new HeartbeatService(mockRepo, 50); // 50ms interval
  });

  afterEach(() => {
    heartbeat.stopAll();
  });

  it("starts heartbeat for a task", async () => {
    heartbeat.start("task-1");
    await sleep(150); // allow ~2-3 ticks
    expect(mockRepo.updateHeartbeat).toHaveBeenCalledWith("task-1");
    expect(mockRepo.updateHeartbeat).toHaveBeenCalled();

    heartbeat.stop("task-1");
  });

  it("supports multiple concurrent tasks", async () => {
    heartbeat.start("task-1");
    heartbeat.start("task-2");
    await sleep(75);

    expect(mockRepo.updateHeartbeat).toHaveBeenCalledWith("task-1");
    expect(mockRepo.updateHeartbeat).toHaveBeenCalledWith("task-2");

    heartbeat.stop("task-1");
    await sleep(75);

    // task-1 stops, task-2 continues
    mockRepo.updateHeartbeat.mockClear();
    await sleep(75);
    expect(mockRepo.updateHeartbeat).not.toHaveBeenCalledWith("task-1");
    expect(mockRepo.updateHeartbeat).toHaveBeenCalledWith("task-2");
  });

  it("stopAll stops everything", async () => {
    heartbeat.start("t1");
    heartbeat.start("t2");
    heartbeat.stopAll();

    mockRepo.updateHeartbeat.mockClear();
    await sleep(100);
    expect(mockRepo.updateHeartbeat).not.toHaveBeenCalled();
  });
});
