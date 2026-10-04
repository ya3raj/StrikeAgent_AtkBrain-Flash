"""Security invariants for the opt-in strict external federation boundary."""

from __future__ import annotations

import ipaddress

from ..scope import Scope
from .guard import strict_external_command_reason


def _scope(target: str = "93.184.216.34") -> Scope:
    return Scope(
        targets=[target],
        ports=[80, 443],
        allow_subdomains=False,
        mode="strict-external",
        dns_pins={target: [target]},
    )


def test_exact_endpoint_does_not_expand_hosts_or_ports() -> None:
    scope = _scope()
    assert scope.exact_endpoint_in_scope("93.184.216.34", 443)
    assert not scope.exact_endpoint_in_scope("93.184.216.35", 443)
    assert not scope.exact_endpoint_in_scope("93.184.216.34", 8443)
    assert not scope.host_in_scope("example.com")


def test_shell_connector_accepts_only_literal_exact_endpoint() -> None:
    scope = _scope()
    assert strict_external_command_reason(
        "curl https://93.184.216.34/", scope,
        pairs=[("93.184.216.34", 443)], cidrs=[],
    ) is None
    assert "outside exact scope" in (strict_external_command_reason(
        "curl https://93.184.216.35/", scope,
        pairs=[("93.184.216.35", 443)], cidrs=[],
    ) or "")


def test_shell_hostname_and_unsafe_curl_features_fail_closed() -> None:
    hostname_scope = Scope(
        targets=["example.com"], ports=[443], mode="strict-external",
        dns_pins={"example.com": ["93.184.216.34"]},
    )
    assert "literal IP" in (strict_external_command_reason(
        "curl https://example.com/", hostname_scope,
        pairs=[("example.com", 443)], cidrs=[],
    ) or "")
    for flag in ("-k", "--insecure", "-L", "--location", "--proxy=http://127.0.0.1:9"):
        reason = strict_external_command_reason(
            f"curl {flag} https://93.184.216.34/", _scope(),
            pairs=[("93.184.216.34", 443)], cidrs=[],
        )
        assert reason and "connector option" in reason


def test_local_tools_allowed_but_interpreters_and_shell_composition_blocked() -> None:
    scope = _scope()
    assert strict_external_command_reason("sha256sum artifact.bin", scope) is None
    assert strict_external_command_reason("python -c 'print(1)'", scope)
    assert strict_external_command_reason("echo ok | curl https://93.184.216.34", scope)


def test_documentation_address_used_by_fixture_is_public_for_policy() -> None:
    # Protect the fixture from accidentally drifting to a private/loopback pin.
    assert ipaddress.ip_address("93.184.216.34").is_global
