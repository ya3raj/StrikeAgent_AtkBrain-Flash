#!/usr/bin/env python3
"""Exit successfully only when the surrounding unit enforces its IP policy."""
from __future__ import annotations

import argparse
import errno
import socket


def result(address: tuple[str, int]) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as stream:
        stream.settimeout(2)
        return stream.connect_ex(address)


parser = argparse.ArgumentParser()
parser.add_argument("--baseline", action="store_true")
args = parser.parse_args()

local_result = result(("127.0.0.1", 1))
external_result = result(("1.1.1.1", 443))
print({"localhost": local_result, "undeclared": external_result}, flush=True)
if local_result != errno.ECONNREFUSED:
    raise SystemExit(f"localhost did not reach the host stack: errno={local_result}")
if args.baseline:
    if external_result != 0:
        raise SystemExit(f"baseline destination was not reachable: errno={external_result}")
elif external_result == 0:
    raise SystemExit("undeclared destination remained reachable inside the service")
