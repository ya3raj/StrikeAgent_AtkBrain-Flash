"""Verify the kernel egress boundary required by strict-external projects.

The service launcher writes a root-owned attestation after systemd has applied
``IPAddressDeny=any`` and the declared ``IPAddressAllow`` entries to the
service cgroup.  The native API never trusts an environment boolean: it checks
the file ownership, the running cgroup, the live systemd properties, and the
project's exact DNS pins before reporting OS egress enforcement.
"""
from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from typing import Callable

from ..scope import Scope, canonical_host


ATTESTATION_ENV = "ATKBRAIN_EGRESS_ATTESTATION_FILE"
SCHEMA = "atkbrain.systemd-egress.v1"
MAX_ATTESTATION_BYTES = 32 * 1024
_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}\.service$")


def _read_exact_json(path: Path) -> dict:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & 0o222
            or info.st_size <= 0
            or info.st_size > MAX_ATTESTATION_BYTES
        ):
            raise ValueError("egress attestation file is not root-owned and immutable")
        data = os.read(descriptor, MAX_ATTESTATION_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(data) > MAX_ATTESTATION_BYTES:
        raise ValueError("egress attestation file is oversized")
    value = json.loads(data.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("egress attestation must be an object")
    return value


def _current_cgroup(path: Path = Path("/proc/self/cgroup")) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        fields = line.split(":", 2)
        if len(fields) == 3 and fields[0] == "0":
            return fields[2]
    raise ValueError("unified cgroup v2 membership is unavailable")


def _systemd_properties(unit: str) -> tuple[set[str], set[str]]:
    completed = subprocess.run(
        [
            "systemctl", "show", unit,
            "--property=IPAddressDeny", "--property=IPAddressAllow",
            "--value", "--no-pager",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
    )
    if completed.returncode != 0:
        raise ValueError("cannot verify live systemd egress properties")
    lines = [line.strip() for line in completed.stdout.splitlines()]
    if len(lines) != 2:
        raise ValueError("systemd returned an unexpected egress property shape")
    # systemctl preserves property order in the request on supported releases,
    # but accept either order and identify the deny line by its literal value.
    deny_indexes = [index for index, line in enumerate(lines) if line.lower() == "any"]
    deny_line = lines[deny_indexes[0]] if len(deny_indexes) == 1 else ""
    allow_line = lines[1 - deny_indexes[0]] if len(deny_indexes) == 1 else ""
    if deny_line.lower() != "any":
        raise ValueError("systemd IPAddressDeny is not any")
    return {"any"}, set(allow_line.split())


def _normalized_addresses(values: object) -> set[str]:
    if not isinstance(values, list) or not values:
        raise ValueError("egress address set is empty")
    result: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            raise ValueError("egress address is not a string")
        address = ipaddress.ip_address(value)
        result.add(f"{address.compressed}/{address.max_prefixlen}")
    return result


def kernel_egress_error(
    scope: Scope,
    *,
    environ: dict[str, str] | None = None,
    attestation_reader: Callable[[Path], dict] | None = None,
    cgroup_reader: Callable[[], str] | None = None,
    property_reader: Callable[[str], tuple[set[str], set[str]]] | None = None,
) -> str | None:
    """Return ``None`` only when the live service cgroup covers this scope."""

    env = os.environ if environ is None else environ
    raw_path = env.get(ATTESTATION_ENV, "")
    if not raw_path or not os.path.isabs(raw_path):
        return "strict-external requires an absolute kernel egress attestation path"
    try:
        value = (attestation_reader or _read_exact_json)(Path(raw_path))
        required = {
            "schema", "backend", "unit", "cgroup", "target_addresses",
            "provider_addresses", "dns_addresses", "allowed_ports",
        }
        if set(value) != required:
            raise ValueError("egress attestation fields do not match the schema")
        if value["schema"] != SCHEMA or value["backend"] != "systemd-cgroup-bpf":
            raise ValueError("egress attestation backend is unsupported")
        unit = value["unit"]
        cgroup = value["cgroup"]
        if not isinstance(unit, str) or _UNIT.fullmatch(unit) is None:
            raise ValueError("egress attestation unit is invalid")
        if not isinstance(cgroup, str) or not cgroup.endswith("/" + unit):
            raise ValueError("egress attestation cgroup is invalid")
        current = (cgroup_reader or _current_cgroup)()
        if current != cgroup:
            raise ValueError("running process is outside the attested cgroup")

        target_addresses = _normalized_addresses(value["target_addresses"])
        _normalized_addresses(value["provider_addresses"])
        _normalized_addresses(value["dns_addresses"])
        ports = value["allowed_ports"]
        if (
            not isinstance(ports, list)
            or any(isinstance(port, bool) or not isinstance(port, int) for port in ports)
            or sorted(set(ports)) != ports
            or any(port < 1 or port > 65535 for port in ports)
        ):
            raise ValueError("egress attestation ports are invalid")

        pins: set[str] = set()
        for target in scope.targets:
            key = canonical_host(target)
            for pin in (scope.dns_pins or {}).get(key, []):
                address = ipaddress.ip_address(pin)
                pins.add(f"{address.compressed}/{address.max_prefixlen}")
        if not pins or not pins.issubset(target_addresses):
            raise ValueError("kernel target addresses do not cover the project DNS pins")
        if not set(int(port) for port in scope.ports).issubset(set(ports)):
            raise ValueError("kernel egress policy does not cover the project ports")

        _deny, live_allow = (property_reader or _systemd_properties)(unit)
        declared = (
            target_addresses
            | _normalized_addresses(value["provider_addresses"])
            | _normalized_addresses(value["dns_addresses"])
        )
        # localhost is required for UltraHackBot's loopback control channel.
        live_normalized = {item.lower() for item in live_allow}
        localhost_live = "localhost" in live_normalized or {
            "127.0.0.0/8", "::1/128",
        }.issubset(live_normalized)
        if not localhost_live:
            raise ValueError("systemd egress policy does not admit localhost control")
        without_localhost = live_normalized - {"localhost", "127.0.0.0/8", "::1/128"}
        if declared != without_localhost:
            raise ValueError("live systemd IPAddressAllow differs from the attestation")
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
        return f"kernel egress verification failed: {exc}"
    return None
