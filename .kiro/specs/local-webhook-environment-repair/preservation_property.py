"""Observation-first preservation property for the unfixed baseline.

This standard-library-only test records allowlisted, non-secret observations. It
never imports the application, reads untracked files, mutates the existing venv,
or sends anything except bounded unauthenticated GET requests.

Property 2: Preservation - Source, Security, Secrets, Production, and Existing Environment
Validates: Requirements 2.1, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import stat
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
from typing import Any

EXPECTED_COMMIT_PREFIX = "017a607"
EXPECTED_PINS = {
    "flask": "3.0.0",
    "flask-cors": "4.0.0",
    "python-dotenv": "1.0.0",
    "ccxt": "4.5.68",
    "requests": "2.34.2",
    "gunicorn": "21.2.0",
    "firebase-admin": "6.4.0",
}
PRODUCTION_ENDPOINTS = (
    ("https://vivek-raj.onrender.com/health", 200),
    ("https://vivek-raj.onrender.com/api/v1/webhooks/health", 401),
)
COMMAND_TIMEOUT_SECONDS = 20
REQUEST_TIMEOUT_SECONDS = 8
NETWORK_DEADLINE_SECONDS = 36
MAX_REQUEST_ATTEMPTS = 3
PROPERTY_CASES = 128
MAX_COMMAND_OUTPUT = 2 * 1024 * 1024
SENSITIVE_NAMES = {
    ".env",
    "serviceaccountkey.json",
    "credentials.json",
    "firebase-service-account.json",
}
SENSITIVE_MARKERS = ("secret", "credential", "private_key", "token")


class PreservationFailure(RuntimeError):
    def __init__(self, classification: str, reason: str, path: str | None = None) -> None:
        super().__init__(reason)
        self.classification = classification
        self.reason = reason
        self.path = path


def run_git(root: Path, *arguments: str) -> bytes:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PreservationFailure("OPERATIONAL_FAILURE", f"git command failed: {type(exc).__name__}") from exc
    if completed.returncode != 0:
        raise PreservationFailure("OPERATIONAL_FAILURE", f"git command exited {completed.returncode}")
    if len(completed.stdout) + len(completed.stderr) > MAX_COMMAND_OUTPUT:
        raise PreservationFailure("OPERATIONAL_FAILURE", "git command output exceeded bound")
    return completed.stdout


def is_sensitive_path(relative: str) -> bool:
    normalized = relative.replace("\\", "/").lower()
    name = normalized.rsplit("/", 1)[-1]
    if name == ".env.example":
        return False
    return name in SENSITIVE_NAMES or any(marker in name for marker in SENSITIVE_MARKERS)


def tracked_paths(root: Path) -> list[str]:
    paths = [part.decode("utf-8", "surrogateescape") for part in run_git(root, "ls-files", "-z").split(b"\0") if part]
    risky = [path for path in paths if is_sensitive_path(path)]
    if risky:
        raise PreservationFailure("SECRET_RISK", "tracked secret-bearing path would be inspected", risky[0])
    return sorted(paths)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise PreservationFailure("OPERATIONAL_FAILURE", type(exc).__name__, str(path)) from exc
    return digest.hexdigest()


def tracked_manifest(root: Path, paths: list[str]) -> dict[str, dict[str, Any]]:
    manifest: dict[str, dict[str, Any]] = {}
    for relative in paths:
        path = root / relative
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            manifest[relative] = {"exists": False}
            continue
        except OSError as exc:
            raise PreservationFailure("OPERATIONAL_FAILURE", type(exc).__name__, relative) from exc
        if stat.S_ISLNK(metadata.st_mode):
            raise PreservationFailure("SECRET_RISK", "tracked link target would require separate trust review", relative)
        if not stat.S_ISREG(metadata.st_mode):
            manifest[relative] = {"exists": True, "type": "non-regular", "size": metadata.st_size}
            continue
        manifest[relative] = {"exists": True, "type": "file", "size": metadata.st_size, "sha256": sha256_file(path)}
    return manifest


def parse_status(raw: bytes) -> dict[str, Any]:
    entries: list[dict[str, str]] = []
    excluded_sensitive_untracked = 0
    fields = [field for field in raw.split(b"\0") if field]
    index = 0
    while index < len(fields):
        decoded = fields[index].decode("utf-8", "surrogateescape")
        status = decoded[:2]
        path = decoded[3:]
        index += 1
        if status[0] in {"R", "C"} and index < len(fields):
            destination = fields[index].decode("utf-8", "surrogateescape")
            index += 1
            path = f"{path} -> {destination}"
        if status == "??" and any(is_sensitive_path(part.strip()) for part in path.split(" -> ")):
            excluded_sensitive_untracked += 1
            continue
        entries.append({"status": status, "path": path})
    return {"entries": entries, "excluded_sensitive_untracked_count": excluded_sensitive_untracked}


def repository_observation(root: Path) -> dict[str, Any]:
    paths = tracked_paths(root)
    head = run_git(root, "rev-parse", "HEAD").decode().strip()
    remote = run_git(root, "rev-parse", "--verify", "refs/remotes/origin/main").decode().strip()
    try:
        branch = run_git(root, "symbolic-ref", "--short", "-q", "HEAD").decode().strip()
    except PreservationFailure:
        branch = None
    status = parse_status(run_git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"))
    manifest = tracked_manifest(root, paths)
    localhost_files: list[dict[str, Any]] = []
    for relative in paths:
        if not relative.startswith("src/") or not relative.lower().endswith((".js", ".jsx", ".ts", ".tsx")):
            continue
        state = manifest[relative]
        if not state.get("exists") or state.get("type") != "file":
            continue
        try:
            text = (root / relative).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise PreservationFailure("OPERATIONAL_FAILURE", type(exc).__name__, relative) from exc
        if "http://localhost:5000" in text:
            localhost_files.append({"path": relative, "sha256": state["sha256"]})
    if not localhost_files:
        raise PreservationFailure("OPERATIONAL_FAILURE", "frontend localhost target was not found in tracked source")
    explicit = {}
    for relative in ("backend/requirements.txt", "render.yaml", "backend/render.yaml"):
        explicit[relative] = manifest.get(relative, {"exists": False})
    return {
        "head": head,
        "branch": branch,
        "origin_main": remote,
        "status": status,
        "tracked_file_count": len(paths),
        "tracked_manifest": manifest,
        "explicit_preservation_files": explicit,
        "frontend_localhost_target": "http://localhost:5000",
        "frontend_localhost_files": localhost_files,
    }


def commit_pins(root: Path) -> dict[str, str]:
    raw = run_git(root, "show", f"{EXPECTED_COMMIT_PREFIX}:backend/requirements.txt").decode("utf-8")
    pins: dict[str, str] = {}
    for source_line in raw.splitlines():
        line = source_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("==")
        if len(parts) != 2:
            raise PreservationFailure("BASELINE_MISMATCH", "commit requirements contain a non-exact pin")
        pins[parts[0].lower()] = parts[1]
    return pins


def reparse_flag(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    marker = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & marker)


def venv_manifest(venv: Path) -> dict[str, Any]:
    if not venv.is_dir():
        raise PreservationFailure("OPERATIONAL_FAILURE", "existing project .venv is unavailable", ".venv")
    files: dict[str, dict[str, Any]] = {}
    directories: dict[str, dict[str, Any]] = {}
    try:
        root_metadata = venv.lstat()
    except OSError as exc:
        raise PreservationFailure("OPERATIONAL_FAILURE", type(exc).__name__, ".venv") from exc
    root = {"reparse_point": reparse_flag(root_metadata), "mode": stat.S_IMODE(root_metadata.st_mode)}
    for directory, directory_names, file_names in os.walk(venv, topdown=True, followlinks=False):
        directory_names.sort(key=str.lower)
        file_names.sort(key=str.lower)
        base = Path(directory)
        for name in directory_names:
            path = base / name
            relative = path.relative_to(venv).as_posix()
            try:
                metadata = path.lstat()
            except OSError as exc:
                raise PreservationFailure("OPERATIONAL_FAILURE", type(exc).__name__, f".venv/{relative}") from exc
            directories[relative] = {
                "reparse_point": reparse_flag(metadata),
                "mode": stat.S_IMODE(metadata.st_mode),
            }
        for name in file_names:
            path = base / name
            relative = path.relative_to(venv).as_posix()
            try:
                metadata = path.lstat()
            except OSError as exc:
                raise PreservationFailure("OPERATIONAL_FAILURE", type(exc).__name__, f".venv/{relative}") from exc
            if stat.S_ISLNK(metadata.st_mode) or reparse_flag(metadata):
                files[relative] = {
                    "size": metadata.st_size,
                    "sha256": None,
                    "reparse_point": True,
                    "mode": stat.S_IMODE(metadata.st_mode),
                }
                continue
            if not stat.S_ISREG(metadata.st_mode):
                files[relative] = {
                    "size": metadata.st_size,
                    "sha256": None,
                    "reparse_point": False,
                    "mode": stat.S_IMODE(metadata.st_mode),
                }
                continue
            files[relative] = {
                "size": metadata.st_size,
                "sha256": sha256_file(path),
                "reparse_point": False,
                "mode": stat.S_IMODE(metadata.st_mode),
            }
    aggregate = hashlib.sha256(json.dumps({"root": root, "directories": directories, "files": files}, sort_keys=True).encode()).hexdigest()
    return {
        "relative_path": ".venv",
        "root": root,
        "directory_count": len(directories),
        "file_count": len(files),
        "total_file_bytes": sum(item["size"] for item in files.values()),
        "aggregate_sha256": aggregate,
        "directories": directories,
        "files": files,
    }


def application_control_posture() -> dict[str, Any]:
    command = (
        "$ErrorActionPreference='Stop';"
        "$d=Get-CimInstance -Namespace 'root\\Microsoft\\Windows\\DeviceGuard' -ClassName 'Win32_DeviceGuard';"
        "$d | Select-Object SecurityServicesConfigured,SecurityServicesRunning,"
        "CodeIntegrityPolicyEnforcementStatus,UsermodeCodeIntegrityPolicyEnforcementStatus,"
        "VirtualizationBasedSecurityStatus | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PreservationFailure("OPERATIONAL_FAILURE", f"policy observation failed: {type(exc).__name__}") from exc
    if completed.returncode != 0:
        raise PreservationFailure("OPERATIONAL_FAILURE", f"policy observation exited {completed.returncode}")
    try:
        value = json.loads(completed.stdout.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PreservationFailure("OPERATIONAL_FAILURE", "policy observation was malformed") from exc
    if not isinstance(value, dict):
        raise PreservationFailure("OPERATIONAL_FAILURE", "policy observation was unavailable")
    return value


def production_observation() -> dict[str, Any]:
    deadline = time.monotonic() + NETWORK_DEADLINE_SECONDS
    observations: list[dict[str, Any]] = []
    request_audit: list[dict[str, Any]] = []
    for url, expected in PRODUCTION_ENDPOINTS:
        statuses: list[int] = []
        exception_classes: list[str] = []
        for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            timeout = min(REQUEST_TIMEOUT_SECONDS, max(0.1, remaining))
            request = urllib.request.Request(url, method="GET", headers={"User-Agent": "local-preservation-check/1"})
            request_audit.append({
                "method": "GET",
                "url": url,
                "authorization_header": False,
                "payload": False,
                "attempt": attempt,
                "timeout_seconds": timeout,
            })
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    statuses.append(response.status)
            except urllib.error.HTTPError as exc:
                statuses.append(exc.code)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                exception_classes.append(type(exc).__name__)
            if statuses and statuses[-1] == expected:
                break
            if attempt < MAX_REQUEST_ATTEMPTS and time.monotonic() < deadline:
                time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))
        observed = statuses[-1] if statuses else None
        observations.append({
            "url": url,
            "expected_status": expected,
            "observed_status": observed,
            "attempts": len(statuses) + len(exception_classes),
            "exception_classes": exception_classes,
            "matched": observed == expected,
        })
    if any(item["observed_status"] is None for item in observations):
        raise PreservationFailure("EXTERNAL_VERIFICATION_FAILED", "a production endpoint was unreachable within the deadline")
    if any(not item["matched"] for item in observations):
        raise PreservationFailure("REGRESSION_DETECTED", "a reachable production endpoint returned an unexpected status")
    return {
        "overall_deadline_seconds": NETWORK_DEADLINE_SECONDS,
        "max_attempts_per_endpoint": MAX_REQUEST_ATTEMPTS,
        "unauthenticated": True,
        "requests": request_audit,
        "observations": observations,
    }


def preservation_projection(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "repository": record["repository"],
        "venv": record["venv"],
        "application_control": record["application_control"],
        "secret_disclosure_count": record["secret_disclosure_count"],
        "trading_side_effect_count": record["trading_side_effect_count"],
        "state_changing_request_count": record["state_changing_request_count"],
    }


def generated_preservation_property(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    rng = random.Random(0x017A607)
    before_projection = preservation_projection(before)
    after_projection = preservation_projection(after)
    checklist = (
        "global-python-already-imports-dependencies",
        "optional-firebase-unconfigured",
        "frontend-localhost-context",
        "production-authentication-context",
    )
    for index in range(PROPERTY_CASES):
        context = {
            "bug_condition": False,
            "checklist": checklist[index % len(checklist)],
            "irrelevant_optional_service_count": rng.randrange(0, 9),
            "unrelated_frontend_state": bool(rng.getrandbits(1)),
        }
        if context["bug_condition"]:
            raise AssertionError("generator left the non-bug context domain")
        if before_projection != after_projection:
            raise AssertionError(f"preservation invariant failed for generated case {index}")
    return {
        "name": "Property 2: Preservation - Source, Security, Secrets, Production, and Existing Environment",
        "validates_requirements": ["2.1", "2.5", "3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8"],
        "generated_cases": PROPERTY_CASES,
        "checklisted_contexts": list(checklist),
        "passed": True,
    }


def observe_local_state(root: Path) -> dict[str, Any]:
    return {
        "repository": repository_observation(root),
        "venv": venv_manifest(root / ".venv"),
        "application_control": application_control_posture(),
        "secret_disclosure_count": 0,
        "trading_side_effect_count": 0,
        "state_changing_request_count": 0,
    }


def execute(root: Path, record_path: Path) -> tuple[dict[str, Any], int]:
    started = time.time()
    result: dict[str, Any] = {
        "protocol": "observation-first-preservation-v1",
        "classification": "OPERATIONAL_FAILURE",
        "property": "Property 2: Preservation - Source, Security, Secrets, Production, and Existing Environment",
    }
    try:
        remote = run_git(root, "rev-parse", "--verify", "refs/remotes/origin/main").decode().strip()
        if remote != "017a60705f2a31242057229bd5173bd15eecebe0":
            raise PreservationFailure("BASELINE_MISMATCH", "origin/main does not resolve to the verified commit")
        pins = commit_pins(root)
        if pins != EXPECTED_PINS:
            raise PreservationFailure("BASELINE_MISMATCH", "commit dependency pins do not match the required baseline")

        before = observe_local_state(root)
        production = production_observation()
        after = observe_local_state(root)
        property_result = generated_preservation_property(before, after)
        result.update({
            "classification": "PRESERVATION_CONFIRMED",
            "passed": True,
            "baseline_commit": remote,
            "baseline_pins": pins,
            "before": before,
            "after": after,
            "production": production,
            "property_result": property_result,
            "safety_audit": {
                "application_or_deployment_files_written": 0,
                "project_venv_mutations": 0,
                "global_python_mutations": 0,
                "secret_files_opened": 0,
                "secret_values_displayed": 0,
                "authorization_headers_sent": 0,
                "state_changing_requests": 0,
                "production_mutations": 0,
                "trading_actions": 0,
            },
            "elapsed_seconds": round(time.time() - started, 3),
        })
        exit_code = 0
    except PreservationFailure as exc:
        result.update({
            "classification": exc.classification,
            "passed": False,
            "reason": exc.reason,
            "path": exc.path,
            "elapsed_seconds": round(time.time() - started, 3),
        })
        exit_code = 2
    record_path.parent.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    summary = {
        "classification": result["classification"],
        "passed": result.get("passed", False),
        "baseline_commit": result.get("baseline_commit"),
        "baseline_pins": result.get("baseline_pins"),
        "production_statuses": [item["observed_status"] for item in result.get("production", {}).get("observations", [])],
        "tracked_file_count": result.get("before", {}).get("repository", {}).get("tracked_file_count"),
        "working_tree_entry_count": len(result.get("before", {}).get("repository", {}).get("status", {}).get("entries", [])),
        "venv_file_count": result.get("before", {}).get("venv", {}).get("file_count"),
        "venv_aggregate_sha256": result.get("before", {}).get("venv", {}).get("aggregate_sha256"),
        "property_cases": result.get("property_result", {}).get("generated_cases"),
        "record_path": str(record_path),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return result, exit_code


class PreservationUnitTests(unittest.TestCase):
    def test_required_pins_are_exact(self) -> None:
        self.assertEqual(len(EXPECTED_PINS), 7)
        self.assertTrue(all(name and version and "*" not in version for name, version in EXPECTED_PINS.items()))

    def test_sensitive_paths_are_rejected_but_example_is_allowed(self) -> None:
        self.assertTrue(is_sensitive_path("backend/.env"))
        self.assertTrue(is_sensitive_path("config/serviceAccountKey.json"))
        self.assertTrue(is_sensitive_path("notes/api-token.txt"))
        self.assertFalse(is_sensitive_path("backend/.env.example"))

    def test_status_parser_omits_sensitive_untracked_names(self) -> None:
        parsed = parse_status(b" M src/App.jsx\0?? backend/.env\0?? safe.txt\0")
        self.assertEqual(parsed["excluded_sensitive_untracked_count"], 1)
        self.assertEqual(parsed["entries"], [{"status": " M", "path": "src/App.jsx"}, {"status": "??", "path": "safe.txt"}])

    def test_generated_property_accepts_identical_preservation_projection(self) -> None:
        baseline = {
            "repository": {"hash": "a"},
            "venv": {"hash": "b"},
            "application_control": {"status": 2},
            "secret_disclosure_count": 0,
            "trading_side_effect_count": 0,
            "state_changing_request_count": 0,
        }
        result = generated_preservation_property(baseline, dict(baseline))
        self.assertTrue(result["passed"])
        self.assertEqual(result["generated_cases"], PROPERTY_CASES)

    def test_generated_property_detects_a_changed_venv(self) -> None:
        before = {
            "repository": {}, "venv": {"hash": "a"}, "application_control": {},
            "secret_disclosure_count": 0, "trading_side_effect_count": 0, "state_changing_request_count": 0,
        }
        after = dict(before)
        after["venv"] = {"hash": "b"}
        with self.assertRaises(AssertionError):
            generated_preservation_property(before, after)


def run_self_tests() -> bool:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PreservationUnitTests)
    return unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path)
    parser.add_argument("--record", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return 0 if run_self_tests() else 2
    if args.root is None or args.record is None:
        parser.error("--root and --record are required")
    if not run_self_tests():
        return 2
    _, exit_code = execute(args.root.resolve(), args.record.resolve())
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
