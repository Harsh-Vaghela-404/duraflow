import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from duraflow._generated.agent.service_pb2_grpc import AgentServiceStub
from duraflow._generated.agent.service_pb2 import (
     SubmitTaskRequest,
     SubmitTaskResponse,
     GetTaskStatusRequest,
     GetTaskStatusResponse,
     CancelTaskRequest,
     CancelTaskResponse,
     GetRateLimitStatusRequest,
     GetRateLimitStatusResponse,
     ResetRateLimitRequest,
     ResetRateLimitResponse,
     GetStepRequest,
     GetStepResponse,
     CompleteStepRequest,
     CompleteStepResponse,
     FailStepRequest,
     FailStepResponse
)
