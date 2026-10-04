# Strict-external kernel egress

The `strict-external` API contract refuses to start a hunt unless the backend is
running in a systemd service whose live cgroup policy denies every undeclared
destination address. Use the bundled launcher as root and a dedicated
unprivileged service account:

```bash
sudo env PYTHONPATH=/opt/strike/backend \
  /opt/strike/venv/bin/python -m atkbrain.exec.egress_launcher \
  --unit ultrahackbot-strike --run-as atkbrain \
  --attestation-file /run/ultrahackbot/strike-egress.json \
  --target-address 93.184.216.34 \
  --provider-address 104.18.6.192 \
  --dns-address 1.1.1.1 --port 443 -- \
  /opt/strike/venv/bin/python -m atkbrain.main
```

Resolve and review every address immediately before launch. The helper rejects
non-public target/provider addresses, uses fixed argv without a shell, creates a
root-owned attestation, and applies `IPAddressDeny=any`. The backend verifies its
exact cgroup and live `IPAddressAllow` values before each strict run. Missing,
extra, or changed addresses fail closed. Exact target ports, DNS pins, redirect
handling, and connector arguments are enforced by the native strict-external
scope on every run.

Use `--dry-run` first to inspect the attestation and complete `systemd-run` argv.
