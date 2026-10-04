"""Launch StrikeAgent in a systemd cgroup with deny-by-default IP egress."""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile

from .egress import ATTESTATION_ENV, SCHEMA


_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,119}$")


def _addresses(values: list[str], field: str) -> list[str]:
    if not values:
        raise ValueError(f"{field} requires at least one address")
    result = sorted({ipaddress.ip_address(value).compressed for value in values})
    if field in {"target", "provider"} and any(
        not ipaddress.ip_address(value).is_global for value in result
    ):
        raise ValueError(f"{field} addresses must be public")
    return result


def _ports(values: list[int]) -> list[int]:
    if not values or any(isinstance(value, bool) or not 1 <= value <= 65535 for value in values):
        raise ValueError("allowed ports must be integers between 1 and 65535")
    return sorted(set(values))


def _write_attestation(path: Path, value: dict) -> None:
    if os.geteuid() != 0:
        raise PermissionError("the egress launcher must run as root")
    path = path.resolve(strict=False)
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".egress-", dir=path.parent)
    try:
        # Root owns the immutable statement; the unprivileged service may read it.
        os.fchmod(descriptor, 0o444)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def build_launch(
    *,
    unit: str,
    run_as: str,
    attestation_path: Path,
    target_addresses: list[str],
    provider_addresses: list[str],
    dns_addresses: list[str],
    allowed_ports: list[int],
    command: list[str],
) -> tuple[dict, list[str]]:
    if _UNIT.fullmatch(unit) is None:
        raise ValueError("unit name is invalid")
    account = pwd.getpwnam(run_as)
    if account.pw_uid == 0:
        raise ValueError("StrikeAgent must not run as root")
    if not command or any(not isinstance(part, str) or not part for part in command):
        raise ValueError("a fixed argv command is required")
    targets = _addresses(target_addresses, "target")
    providers = _addresses(provider_addresses, "provider")
    dns = _addresses(dns_addresses, "dns")
    ports = _ports(allowed_ports)
    service = unit + ".service"
    cgroup = "/system.slice/" + service
    attestation = {
        "schema": SCHEMA,
        "backend": "systemd-cgroup-bpf",
        "unit": service,
        "cgroup": cgroup,
        "target_addresses": targets,
        "provider_addresses": providers,
        "dns_addresses": dns,
        "allowed_ports": ports,
    }
    allow = ["localhost", *[f"{value}/{ipaddress.ip_address(value).max_prefixlen}" for value in targets + providers + dns]]
    argv = [
        "systemd-run", "--quiet", "--collect", "--service-type=exec",
        f"--unit={unit}", f"--uid={run_as}",
        "--property=IPAddressDeny=any",
        "--property=NoNewPrivileges=yes",
        "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
        f"--setenv={ATTESTATION_ENV}={attestation_path.resolve(strict=False)}",
    ]
    argv.extend(f"--property=IPAddressAllow={item}" for item in allow)
    argv.extend(["--", *command])
    return attestation, argv


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit", default="ultrahackbot-strike")
    parser.add_argument("--run-as", required=True)
    parser.add_argument("--attestation-file", required=True, type=Path)
    parser.add_argument("--target-address", action="append", required=True)
    parser.add_argument("--provider-address", action="append", required=True)
    parser.add_argument("--dns-address", action="append", required=True)
    parser.add_argument("--port", action="append", required=True, type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    attestation, launch = build_launch(
        unit=args.unit,
        run_as=args.run_as,
        attestation_path=args.attestation_file,
        target_addresses=args.target_address,
        provider_addresses=args.provider_address,
        dns_addresses=args.dns_address,
        allowed_ports=args.port,
        command=command,
    )
    if args.dry_run:
        print(json.dumps({"attestation": attestation, "argv": launch}, indent=2, sort_keys=True))
        return 0
    _write_attestation(args.attestation_file, attestation)
    completed = subprocess.run(launch, check=False)
    if completed.returncode != 0:
        try:
            args.attestation_file.unlink()
        except OSError:
            pass
        raise SystemExit(completed.returncode)
    print(json.dumps({"unit": attestation["unit"], "cgroup": attestation["cgroup"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
