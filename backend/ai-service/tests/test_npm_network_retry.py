"""Exercise the image's dependency retry boundary without a registry or Node."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "document-tools/npm-network-retry.sh"


def run_install(tmp_path, errors, *args):
    npm = tmp_path / "npm"
    npm.write_text(
        f"#!{sys.executable}\n"
        "import json, os, pathlib, sys\n"
        "root = pathlib.Path(os.environ['FAKE_NPM_ROOT'])\n"
        "calls = root / 'calls.jsonl'\n"
        "attempt = len(calls.read_text().splitlines()) if calls.exists() else 0\n"
        "with calls.open('a') as stream: stream.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "errors = json.loads(os.environ['FAKE_NPM_ERRORS'])\n"
        "error = errors[attempt] if attempt < len(errors) else None\n"
        "if error:\n"
        "    print('npm error code ' + error, file=sys.stderr)\n"
        "    sys.exit(42)\n"
    )
    npm.chmod(0o755)
    sleep = tmp_path / "sleep"
    sleep.write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$FAKE_NPM_ROOT/sleeps"\n')
    sleep.chmod(0o755)
    result = subprocess.run(
        ["sh", str(SCRIPT), *(args or ("ci", "--ignore-scripts"))],
        env={
            **os.environ,
            "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
            "FAKE_NPM_ROOT": str(tmp_path),
            "FAKE_NPM_ERRORS": json.dumps(errors),
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    calls = tmp_path / "calls.jsonl"
    return result, [
        json.loads(line) for line in calls.read_text().splitlines()
    ] if calls.exists() else []


def test_success_does_not_retry(tmp_path):
    result, calls = run_install(tmp_path, [])
    assert result.returncode == 0
    assert len(calls) == 1
    assert not (tmp_path / "sleeps").exists()


@pytest.mark.parametrize(
    "error", ["ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "E503", "E429"]
)
def test_network_failure_recovers_with_bounded_backoff(tmp_path, error):
    result, calls = run_install(tmp_path, [error, error])
    assert result.returncode == 0
    assert len(calls) == 3
    assert calls[0] == calls[1] == calls[2]
    assert calls[0] == [
        "ci",
        "--ignore-scripts",
        "--prefer-offline",
        "--fetch-retries=0",
        "--fetch-timeout=60000",
    ]
    assert (tmp_path / "sleeps").read_text().splitlines() == ["2", "4"]


def test_persistent_network_failure_keeps_original_exit_code(tmp_path):
    result, calls = run_install(tmp_path, ["ECONNRESET"] * 4)
    assert result.returncode == 42
    assert len(calls) == 3
    assert "npm error code ECONNRESET" in result.stderr


@pytest.mark.parametrize(
    "error", ["EUSAGE", "E401", "E403", "E404", "ERESOLVE", "EINTEGRITY", "ELIFECYCLE"]
)
def test_non_network_failure_is_not_retried(tmp_path, error):
    result, calls = run_install(tmp_path, [error])
    assert result.returncode == 42
    assert len(calls) == 1
    assert not (tmp_path / "sleeps").exists()


def test_pdf_install_preserves_prefix_and_lockfile_command(tmp_path):
    result, calls = run_install(
        tmp_path,
        ["ECONNRESET"],
        "ci",
        "--prefix",
        "pdf-runtime",
        "--omit=dev",
        "--ignore-scripts",
    )
    assert result.returncode == 0
    assert len(calls) == 2
    assert calls[0][:5] == [
        "ci",
        "--prefix",
        "pdf-runtime",
        "--omit=dev",
        "--ignore-scripts",
    ]


def test_prune_uses_same_download_policy(tmp_path):
    result, calls = run_install(
        tmp_path, ["E502"], "prune", "--omit=dev", "--ignore-scripts"
    )
    assert result.returncode == 0
    assert len(calls) == 2
    assert calls[0][0] == "prune"


def test_build_is_never_run_by_download_retry(tmp_path):
    result, calls = run_install(tmp_path, [], "run", "build")
    assert result.returncode == 64
    assert calls == []
