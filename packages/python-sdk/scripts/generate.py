"""Proto code generation script — wired in TASK-055."""

from grpc_tools import protoc

import os

script_dir = os.path.dirname(os.path.abspath(__file__))

proto_path = os.path.join(script_dir, "..", "..", "proto")

out_path = os.path.join(script_dir, "..", "src", "duraflow", "_generated")

def main() -> None:
    protoc.main([
        "grpc_tools.protoc",       # argv[0] — name of the program (convention)
        f"--proto_path={proto_path}",
        f"--python_out={out_path}",
        f"--grpc_python_out={out_path}",
        "agent.service.proto",
    ])

if __name__ == "__main__":
    main()
