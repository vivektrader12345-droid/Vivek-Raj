"""Finite, read-only exploration of the local webhook bug condition.

This protocol is deliberately standard-library-only.  It runs each observation in
an independently bounded child process using the explicitly supplied interpreter.
It never starts the application server or performs network requests.

Property 1: Bug Condition - Clean Policy-Compliant Local Backend
Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 3.5, 3.6, 3.7, 3.8
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest
from dataclasses import dataclass
from typing import Any

MAX_PROBES = 6
PROBE_TIMEOUT_SECONDS = 8
MAX_CAPTURE_BYTES = 8192
REQUIRED_PINS = {
    "flask": "3.0.0",
    "flask-cors": "4.0.0",
    "python-dotenv": "1.0.0",
    "ccxt": "4.5.68",
    "requests": "2.34.2",
    "gunicorn": "21.2.0",
    "firebase-admin": "6.4.0",
}
SAFE_ENV_KEYS = {
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
}


@dataclass(frozen=True)
class ProbeSpec:
    name: str
    code: str
    cwd_backend: bool = False


IDENTITY_CODE = r'''
import json, platform, sys
print(json.dumps({
    "ok": True,
    "interpreter": sys.executable,
    "version": platform.python_version(),
    "architecture": platform.architecture()[0],
    "prefix": sys.prefix,
    "base_prefix": sys.base_prefix,
}))
'''

METADATA_CODE = r'''
import importlib.metadata as md
import json, os, site
pins = ["flask", "flask-cors", "python-dotenv", "ccxt", "requests", "gunicorn", "firebase-admin"]
versions = {}
for package in pins:
    try:
        versions[package] = md.version(package)
    except md.PackageNotFoundError:
        versions[package] = None
invalid = []
roots = []
try:
    roots.extend(site.getsitepackages())
except Exception:
    pass
try:
    roots.append(site.getusersitepackages())
except Exception:
    pass
for root in roots:
    if not root or not os.path.isdir(root):
        continue
    try:
        for entry in os.scandir(root):
            if entry.name.startswith("~"):
                invalid.append(entry.name)
    except OSError:
        pass
print(json.dumps({"ok": True, "versions": versions, "invalid_distributions": sorted(set(invalid))}))
'''

REQUESTS_CODE = r'''
import json, warnings
with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    try:
        import requests
        result = {"ok": True, "version": getattr(requests, "__version__", None)}
    except Exception as exc:
        result = {"ok": False, "exception_class": type(exc).__name__}
result["warning_classes"] = sorted(set(type(item.message).__name__ for item in caught))
print(json.dumps(result))
'''

CCXT_CODE = r'''
import json
try:
    import ccxt
    print(json.dumps({"ok": True, "module": "ccxt", "version": getattr(ccxt, "__version__", None)}))
except Exception as exc:
    print(json.dumps({"ok": False, "module": "ccxt", "exception_class": type(exc).__name__}))
'''

GRPC_CODE = r'''
import json, os, re
try:
    import grpc
    from grpc._cython import cygrpc
    print(json.dumps({"ok": True, "module": "grpc/cygrpc", "version": getattr(grpc, "__version__", None)}))
except Exception as exc:
    text = str(exc)
    matches = re.findall(r'([^\\/\s:\"\']+\.(?:dll|pyd))', text, flags=re.IGNORECASE)
    lowered = text.lower()
    policy = any(marker in lowered for marker in ("application control", "blocked by policy", "policy has blocked", "unauthorized"))
    print(json.dumps({
        "ok": False,
        "module": "grpc/cygrpc",
        "exception_class": type(exc).__name__,
        "blocked_filename": os.path.basename(matches[-1]) if matches else None,
        "policy_block_suspected": policy,
    }))
'''

APP_CODE = r'''
import contextlib, io, json, pathlib, sys
backend = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(backend))
captured_out, captured_err = io.StringIO(), io.StringIO()
try:
    with contextlib.redirect_stdout(captured_out), contextlib.redirect_stderr(captured_err):
        import app
    routes = {rule.rule for rule in app.app.url_map.iter_rules()}
    print(json.dumps({
        "ok": True,
        "module": "app",
        "flask_app": bool(app.app),
        "health_route": "/health" in routes,
        "webhook_health_route": "/api/v1/webhooks/health" in routes,
    }))
except Exception as exc:
    print(json.dumps({"ok": False, "module": "app", "exception_class": type(exc).__name__}))
'''

PROTOCOL = (
    ProbeSpec("identity", IDENTITY_CODE),
    ProbeSpec("distribution_metadata", METADATA_CODE),
    ProbeSpec("requests_warning", REQUESTS_CODE),
    ProbeSpec("ccxt_import", CCXT_CODE),
    ProbeSpec("grpc_native_import", GRPC_CODE),
    ProbeSpec("app_import", APP_CODE, cwd_backend=True),
)


def safe_child_environment() -> dict[str, str]:
    child = {key: value for key, value in os.environ.items() if key.upper() in SAFE_ENV_KEYS}
    child.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "AUTO_TRADE_ENABLED": "false",
            "WEBHOOK_LIVE_EXECUTION_ENABLED": "false",
            "LEGACY_WEBHOOK_LIVE_ENABLED": "false",
            "USE_TESTNET": "true",
            "NO_GCE_CHECK": "true",
            "PORT": "5000",
        }
    )
    return child


def source_calls_load_dotenv(source_text: str) -> bool:
    try:
        tree = ast.parse(source_text)
    except (SyntaxError, ValueError):
        return True
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        if isinstance(function, ast.Name) and function.id == "load_dotenv":
            return True
        if isinstance(function, ast.Attribute) and function.attr == "load_dotenv":
            return True
    return False


def app_probe_secret_risk(backend: Path) -> bool:
    env_file = backend / ".env"
    app_file = backend / "app.py"
    if not env_file.exists():
        return False
    try:
        source_text = app_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return True
    return source_calls_load_dotenv(source_text)


def venv_content_fingerprint(venv_root: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    file_count = 0
    total_bytes = 0
    try:
        paths = sorted((path for path in venv_root.rglob("*") if path.is_file()), key=lambda p: str(p).lower())
        for path in paths:
            relative = path.relative_to(venv_root).as_posix()
            size = path.stat().st_size
            digest.update(relative.encode("utf-8", "surrogatepass"))
            digest.update(b"\0")
            digest.update(str(size).encode("ascii"))
            digest.update(b"\0")
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            file_count += 1
            total_bytes += size
    except OSError as exc:
        return {"ok": False, "exception_class": type(exc).__name__}
    return {
        "ok": True,
        "file_count": file_count,
        "total_bytes": total_bytes,
        "sha256": digest.hexdigest(),
    }


def parse_probe_json(stdout: bytes) -> dict[str, Any] | None:
    text = stdout[:MAX_CAPTURE_BYTES].decode("utf-8", "replace")
    for line in reversed(text.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def probe_command(interpreter: Path, backend: Path, spec: ProbeSpec) -> list[str]:
    """Build an isolated command, explicitly binding app imports to supplied source."""
    command = [str(interpreter), "-I", "-c", spec.code]
    if spec.cwd_backend:
        command.append(str(backend.resolve()))
    return command


def run_probe(interpreter: Path, backend: Path, spec: ProbeSpec) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            probe_command(interpreter, backend, spec),
            cwd=str(backend if spec.cwd_backend else backend.parent),
            env=safe_child_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=PROBE_TIMEOUT_SECONDS,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "classification": "TIMEOUT", "deadline_seconds": PROBE_TIMEOUT_SECONDS}
    except OSError as exc:
        return {"ok": False, "classification": "OPERATIONAL_FAILURE", "exception_class": type(exc).__name__}

    result = parse_probe_json(completed.stdout)
    if result is None:
        return {
            "ok": False,
            "classification": "MALFORMED_PROBE_OUTPUT",
            "exit_code": completed.returncode,
            "output_truncated": len(completed.stdout) + len(completed.stderr) > MAX_CAPTURE_BYTES,
        }
    result["exit_code"] = completed.returncode
    result["terminated"] = True
    result["captured_bytes"] = min(len(completed.stdout) + len(completed.stderr), MAX_CAPTURE_BYTES)
    result["output_truncated"] = len(completed.stdout) + len(completed.stderr) > MAX_CAPTURE_BYTES
    return result


def expected_behavior(observations: dict[str, dict[str, Any]], interpreter: Path) -> bool:
    identity = observations.get("identity", {})
    metadata = observations.get("distribution_metadata", {})
    requests_result = observations.get("requests_warning", {})
    ccxt_result = observations.get("ccxt_import", {})
    grpc_result = observations.get("grpc_native_import", {})
    app_result = observations.get("app_import", {})
    versions = metadata.get("versions", {})
    return all(
        (
            identity.get("ok") is True,
            identity.get("version") == "3.11.9",
            identity.get("architecture") == "64bit",
            "onedrive" not in str(interpreter).lower(),
            identity.get("prefix") != identity.get("base_prefix"),
            metadata.get("ok") is True,
            not metadata.get("invalid_distributions"),
            versions == REQUIRED_PINS,
            requests_result.get("ok") is True,
            "RequestsDependencyWarning" not in requests_result.get("warning_classes", []),
            ccxt_result.get("ok") is True,
            grpc_result.get("ok") is True,
            app_result.get("ok") is True,
            app_result.get("health_route") is True,
            app_result.get("webhook_health_route") is True,
            observations.get("local_health", {}).get("health_status") == 200,
            observations.get("local_health", {}).get("webhook_health_status") == 401,
            observations.get("local_health", {}).get("server_terminated") is True,
        )
    )


def concrete_counterexamples(observations: dict[str, dict[str, Any]], interpreter: Path) -> list[dict[str, Any]]:
    counterexamples: list[dict[str, Any]] = []
    identity = observations.get("identity", {})
    if "onedrive" in str(interpreter).lower():
        counterexamples.append({"condition": "ProjectVenvSelected", "observed": "interpreter is inside OneDrive workspace"})
    if identity.get("version") != "3.11.9":
        counterexamples.append({"condition": "UnsupportedPython", "observed": identity.get("version")})

    metadata = observations.get("distribution_metadata", {})
    for invalid in metadata.get("invalid_distributions", []):
        counterexamples.append({"condition": "CorruptMetadata", "package": invalid})
    for package, required in REQUIRED_PINS.items():
        observed = metadata.get("versions", {}).get(package)
        if observed != required:
            counterexamples.append(
                {"condition": "DependencyVersionMismatch", "package": package, "required": required, "observed": observed}
            )

    requests_result = observations.get("requests_warning", {})
    if "RequestsDependencyWarning" in requests_result.get("warning_classes", []):
        counterexamples.append({"condition": "DependencyWarning", "warning_class": "RequestsDependencyWarning"})
    if not observations.get("ccxt_import", {}).get("ok"):
        counterexamples.append(
            {
                "condition": "MissingDependency",
                "module": "ccxt",
                "exception_class": observations.get("ccxt_import", {}).get("exception_class"),
            }
        )
    grpc_result = observations.get("grpc_native_import", {})
    if not grpc_result.get("ok"):
        counterexamples.append(
            {
                "condition": "NativeModuleBlockedOrUnavailable",
                "module": "grpc/cygrpc",
                "exception_class": grpc_result.get("exception_class"),
                "blocked_filename": grpc_result.get("blocked_filename"),
                "policy_block_suspected": grpc_result.get("policy_block_suspected", False),
            }
        )
    app_result = observations.get("app_import", {})
    if app_result.get("classification") == "SECRET_RISK":
        counterexamples.append({"condition": "SecretRisk", "module": "app", "observed": "probe skipped before import"})
    elif not app_result.get("ok"):
        counterexamples.append(
            {"condition": "AppImportFailed", "module": "app", "exception_class": app_result.get("exception_class")}
        )

    counterexamples.append(
        {
            "condition": "BackendHealthUnverified",
            "observed": "server startup and network requests prohibited during exploration",
        }
    )
    return counterexamples


def classify(observations: dict[str, dict[str, Any]], property_holds: bool) -> str:
    if observations.get("app_import", {}).get("classification") == "SECRET_RISK":
        return "SECRET_RISK"
    grpc_result = observations.get("grpc_native_import", {})
    if not grpc_result.get("ok") and grpc_result.get("policy_block_suspected"):
        return "POLICY_BLOCKED"
    if not property_holds:
        return "BUG_REPRODUCED"
    return "BUG_NOT_REPRODUCED"


def explore(interpreter: Path, source: Path) -> tuple[dict[str, Any], int]:
    interpreter = interpreter.resolve()
    source = source.resolve()
    backend = source / "backend"
    venv_root = interpreter.parent.parent
    before = venv_content_fingerprint(venv_root)
    observations: dict[str, dict[str, Any]] = {}

    if len(PROTOCOL) > MAX_PROBES:
        result = {"classification": "OPERATIONAL_FAILURE", "reason": "probe bound exceeded"}
        return result, 2
    if not interpreter.is_file() or not backend.is_dir():
        result = {"classification": "OPERATIONAL_FAILURE", "reason": "interpreter or source location unavailable"}
        return result, 2

    secret_risk = app_probe_secret_risk(backend)
    for spec in PROTOCOL:
        if spec.name == "app_import" and secret_risk:
            observations[spec.name] = {
                "ok": False,
                "classification": "SECRET_RISK",
                "terminated": True,
                "reason": "backend .env exists and app.py calls load_dotenv",
            }
            continue
        observations[spec.name] = run_probe(interpreter, backend, spec)

    observations["local_health"] = {
        "ok": False,
        "classification": "NOT_PROBED",
        "reason": "server startup and network requests prohibited during exploration",
        "server_started": False,
        "server_terminated": True,
    }
    after = venv_content_fingerprint(venv_root)
    preserved = before.get("ok") and before == after
    all_finite = all(result.get("terminated") is True for name, result in observations.items() if name != "local_health")
    operational_failure = any(
        result.get("classification") in {"TIMEOUT", "OPERATIONAL_FAILURE", "MALFORMED_PROBE_OUTPUT"}
        for result in observations.values()
    )
    property_holds = expected_behavior(observations, interpreter)
    classification = classify(observations, property_holds)
    counterexamples = concrete_counterexamples(observations, interpreter)

    result = {
        "protocol": "finite-read-only-bug-condition-v1",
        "property": "Property 1: Bug Condition - Clean Policy-Compliant Local Backend",
        "validates_requirements": ["1.1", "1.2", "1.3", "1.4", "1.5", "3.5", "3.6", "3.7", "3.8"],
        "classification": "OPERATIONAL_FAILURE" if operational_failure else classification,
        "expected_behavior_holds": property_holds,
        "expected_failure_observed": not property_holds and bool(counterexamples),
        "interpreter": str(interpreter),
        "probe_count": len(observations) - 1,
        "max_probe_count": MAX_PROBES,
        "timeout_seconds_per_probe": PROBE_TIMEOUT_SECONDS,
        "observations": observations,
        "counterexamples": counterexamples,
        "preservation": {
            "venv_content_before": before,
            "venv_content_after": after,
            "venv_byte_content_unchanged": preserved,
            "all_probes_finite": all_finite,
            "server_started": False,
            "network_requests_made": 0,
            "pip_mutations": 0,
            "secret_file_read": False,
            "secret_values_displayed": 0,
            "trading_actions": 0,
        },
    }
    safe_success = not operational_failure and not property_holds and bool(counterexamples) and preserved and all_finite
    return result, 1 if safe_success else 2


class ProtocolUnitTests(unittest.TestCase):
    def test_protocol_is_finite_and_data_driven(self) -> None:
        self.assertLessEqual(len(PROTOCOL), MAX_PROBES)
        self.assertEqual(len({spec.name for spec in PROTOCOL}), len(PROTOCOL))
        self.assertTrue(all(PROBE_TIMEOUT_SECONDS > 0 for _ in PROTOCOL))

    def test_dotenv_call_is_detected_without_reading_env_values(self) -> None:
        self.assertTrue(source_calls_load_dotenv("from dotenv import load_dotenv\nload_dotenv()"))
        self.assertFalse(source_calls_load_dotenv("VALUE = 'load_dotenv is only text'"))

    def test_expected_behavior_rejects_unfixed_context(self) -> None:
        observations = {
            "identity": {"ok": True, "version": "3.14.6", "architecture": "64bit", "prefix": "v", "base_prefix": "b"},
            "distribution_metadata": {"ok": True, "versions": REQUIRED_PINS, "invalid_distributions": []},
            "requests_warning": {"ok": True, "warning_classes": []},
            "ccxt_import": {"ok": True},
            "grpc_native_import": {"ok": True},
            "app_import": {"ok": True, "health_route": True, "webhook_health_route": True},
            "local_health": {"health_status": 200, "webhook_health_status": 401, "server_terminated": True},
        }
        self.assertFalse(expected_behavior(observations, Path(r"C:\Users\person\OneDrive\project\.venv\Scripts\python.exe")))

    def test_isolated_app_probe_binds_supplied_backend_source(self) -> None:
        backend = Path(r"C:\synthetic\export\backend")
        command = probe_command(Path(r"C:\repair\venv\Scripts\python.exe"), backend, PROTOCOL[-1])
        self.assertEqual(command[1:3], ["-I", "-c"])
        self.assertEqual(Path(command[-1]), backend.resolve())
        self.assertIn("sys.path.insert(0, str(backend))", command[3])
        self.assertEqual(len(PROTOCOL), 6)

    def test_safe_environment_forces_trading_flags_off(self) -> None:
        child = safe_child_environment()
        self.assertEqual(child["AUTO_TRADE_ENABLED"], "false")
        self.assertEqual(child["WEBHOOK_LIVE_EXECUTION_ENABLED"], "false")
        self.assertEqual(child["LEGACY_WEBHOOK_LIVE_ENABLED"], "false")
        self.assertEqual(child["USE_TESTNET"], "true")
        self.assertEqual(child["NO_GCE_CHECK"], "true")
        self.assertNotIn("BINANCE_API_KEY", child)
        self.assertNotIn("GOOGLE_APPLICATION_CREDENTIALS", child)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interpreter", type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ProtocolUnitTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 2
    if args.interpreter is None or args.source is None:
        parser.error("--interpreter and --source are required for exploration")
    result, exit_code = explore(args.interpreter, args.source)
    print(json.dumps(result, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
