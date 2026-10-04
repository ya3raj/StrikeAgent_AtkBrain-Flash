"""Tests for the strict-external kernel egress attestation."""
from __future__ import annotations

import json
import os
from pathlib import Path

from ..scope import Scope
from .egress import ATTESTATION_ENV, SCHEMA, kernel_egress_error
from .egress_launcher import build_launch


def _scope() -> Scope:
    return Scope(
        targets=["example.com"],
        ports=[443],
        allow_subdomains=False,
        mode="strict-external",
        dns_pins={"example.com": ["93.184.216.34"]},
    )


def _attestation(path: Path) -> dict:
    value = {
        "schema": SCHEMA,
        "backend": "systemd-cgroup-bpf",
        "unit": "ultrahackbot-strike.service",
        "cgroup": "/system.slice/ultrahackbot-strike.service",
        "target_addresses": ["93.184.216.34"],
        "provider_addresses": ["104.18.6.192"],
        "dns_addresses": ["1.1.1.1"],
        "allowed_ports": [443],
    }
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o400)
    return value


def _reader(value: dict):
    return lambda _path: dict(value)


def test_matching_live_cgroup_policy_is_enforced(tmp_path: Path) -> None:
    path = tmp_path / "egress.json"
    value = _attestation(path)
    assert kernel_egress_error(
        _scope(),
        environ={ATTESTATION_ENV: str(path)},
        attestation_reader=_reader(value),
        cgroup_reader=lambda: "/system.slice/ultrahackbot-strike.service",
        property_reader=lambda _unit: (
            {"any"},
            {"localhost", "93.184.216.34/32", "104.18.6.192/32", "1.1.1.1/32"},
        ),
    ) is None


def test_cgroup_or_live_allowlist_drift_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "egress.json"
    value = _attestation(path)
    env = {ATTESTATION_ENV: str(path)}
    assert "outside the attested cgroup" in (kernel_egress_error(
        _scope(), environ=env, attestation_reader=_reader(value),
        cgroup_reader=lambda: "/system.slice/other.service",
    ) or "")
    assert "differs" in (kernel_egress_error(
        _scope(), environ=env, attestation_reader=_reader(value),
        cgroup_reader=lambda: "/system.slice/ultrahackbot-strike.service",
        property_reader=lambda _unit: ({"any"}, {"localhost", "93.184.216.34/32"}),
    ) or "")
    assert "differs" in (kernel_egress_error(
        _scope(), environ=env, attestation_reader=_reader(value),
        cgroup_reader=lambda: "/system.slice/ultrahackbot-strike.service",
        property_reader=lambda _unit: (
            {"any"},
            {
                "localhost", "93.184.216.34/32", "104.18.6.192/32",
                "1.1.1.1/32", "203.0.113.8/32",
            },
        ),
    ) or "")


def test_mutable_or_incomplete_attestation_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "egress.json"
    value = _attestation(path)
    path.chmod(0o600)
    if os.geteuid() == 0:
        assert "root-owned and immutable" in (kernel_egress_error(
            _scope(), environ={ATTESTATION_ENV: str(path)},
        ) or "")
    path.chmod(0o600)
    value["target_addresses"] = ["93.184.216.35"]
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o400)
    assert "do not cover" in (kernel_egress_error(
        _scope(), environ={ATTESTATION_ENV: str(path)},
        attestation_reader=_reader(value),
        cgroup_reader=lambda: "/system.slice/ultrahackbot-strike.service",
    ) or "")


def test_launcher_builds_shell_free_deny_by_default_systemd_argv(tmp_path: Path) -> None:
    attestation, argv = build_launch(
        unit="ultrahackbot-strike-test",
        run_as="nobody",
        attestation_path=tmp_path / "egress.json",
        target_addresses=["93.184.216.34"],
        provider_addresses=["104.18.6.192"],
        dns_addresses=["1.1.1.1"],
        allowed_ports=[443, 80, 443],
        command=["python", "-m", "atkbrain.main"],
    )
    assert attestation["allowed_ports"] == [80, 443]
    assert "--property=IPAddressDeny=any" in argv
    assert "--property=IPAddressAllow=localhost" in argv
    assert "--property=IPAddressAllow=93.184.216.34/32" in argv
    assert argv[-4:] == ["--", "python", "-m", "atkbrain.main"]
