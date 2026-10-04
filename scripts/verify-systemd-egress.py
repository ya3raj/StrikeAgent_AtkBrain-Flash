#!/usr/bin/env python3
"""Exit successfully only when the surrounding unit enforces its IP policy."""
from __future__ import annotations

import errno
import socket


def result(address: tuple[str, int]) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as stream:
        stream.settimeout(2)
        return stream.connect_ex(address)


denied = {errno.EACCES, errno.EPERM}
local_result = result(("127.0.0.1", 1))
external_result = result(("1.1.1.1", 443))
print({"localhost": local_result, "undeclared": external_result}, flush=True)
if local_result in denied:
    raise SystemExit("localhost was denied")
if external_result not in denied:
    raise SystemExit(f"undeclared destination was not denied: errno={external_result}")
