"""Encrypted Ops snapshots and repeatable restores into a NEW isolated Compose project.

The source writers must be stopped (optionally by --stop-writers). No review, approval, model call,
admission change, existing database overwrite or automatic API startup is performed.
Requires the already used Docker Compose and OpenSSL CLIs; no Python dependencies.
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import subprocess
import time
from pathlib import Path
from uuid import uuid4

from ops_snapshot_files import MAX_BYTES, validate

MAGIC = b"GOVBIZ-OPS-SNAPSHOT-1\n"
LABEL = "ai.govbiz.ops-snapshot"
WRITERS = {"ops-service", "ops-sync", "runner", "evaluation-runner"}
FLAGS = ("LLMOPS_LIVE_ENABLED", "LLMOPS_RAG_LIVE_ENABLED", "LLMOPS_SCHEDULES_ENABLED")
HELPER = Path(__file__).with_name("ops_snapshot_files.py").read_text()
AUTH = ["sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec "$@"', "sh"]
DUMP = [
    "mysqldump",
    "-u",
    "root",
    "--default-character-set=utf8mb4",
    "--single-transaction",
    "--no-tablespaces",
    "--set-gtid-purged=OFF",
    "--hex-blob",
    "--order-by-primary",
    "--skip-comments",
    "--skip-dump-date",
    "--skip-extended-insert",
    "--routines",
    "--events",
    "--triggers",
]


class SnapshotError(ValueError):
    """Safe operational diagnostic; never includes private subprocess output."""


def run(args, *, data=None, env=None, timeout=180):
    # Never echo subprocess output: SQL, file contents and credentials are private.
    try:
        return subprocess.run(
            args, input=data, env=env, capture_output=True, check=True, timeout=timeout
        ).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        raise SnapshotError("Snapshot subprocess failed (private output withheld)") from None


def inspect(container):
    return json.loads(run(["docker", "inspect", container]))[0]


def environment(container):
    return dict(item.split("=", 1) for item in container["Config"]["Env"])


def exclusive(path, raw):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())


def key_bytes(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
        info = os.fstat(source.fileno())
        value = source.read(257)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_mode & 0o077
        or info.st_nlink != 1
        or not re.fullmatch(rb"[a-f0-9]{64}\n?", value)
    ):
        raise SnapshotError("Use a private 0600 key created by init-key")
    return value


def crypt(raw, key, *, decrypt=False):
    # Pass the high-entropy password over a pipe, not argv or a temporary plaintext file.
    reader, writer = os.pipe()
    try:
        os.write(writer, key)
        os.close(writer)
        writer = None
        args = [
            "openssl",
            "enc",
            "-aes-256-cbc",
            "-pbkdf2",
            "-iter",
            "210000",
            "-md",
            "sha256",
        ]
        if decrypt:
            args.append("-d")
        args += ["-pass", f"fd:{reader}"]
        try:
            return subprocess.run(
                args,
                input=raw,
                capture_output=True,
                check=True,
                timeout=60,
                pass_fds=(reader,),
            ).stdout
        except (subprocess.SubprocessError, OSError):
            raise SnapshotError("Snapshot encryption/decryption failed") from None
    finally:
        os.close(reader)
        if writer is not None:
            os.close(writer)


def seal(payload, key):
    ciphertext = crypt(json.dumps(payload, sort_keys=True).encode(), key)
    mac_key = hmac.digest(key, b"govbiz-ops-snapshot-authentication-v1", "sha256")
    return MAGIC + hmac.digest(mac_key, MAGIC + ciphertext, "sha256") + ciphertext


def unseal(raw, key):
    if len(raw) > MAX_BYTES * 4 or not raw.startswith(MAGIC):
        raise SnapshotError("Unsupported or oversized snapshot")
    tag, ciphertext = raw[len(MAGIC) : len(MAGIC) + 32], raw[len(MAGIC) + 32 :]
    mac_key = hmac.digest(key, b"govbiz-ops-snapshot-authentication-v1", "sha256")
    if not hmac.compare_digest(tag, hmac.digest(mac_key, MAGIC + ciphertext, "sha256")):
        raise SnapshotError("Snapshot authentication failed; wrong key or modified backup")
    payload = json.loads(crypt(ciphertext, key, decrypt=True))
    if payload["version"] != 1:
        raise SnapshotError("Unsupported snapshot version")
    validate(payload["files"])
    if hashlib.sha256(payload["sql"].encode()).hexdigest() != payload["sql_sha256"]:
        raise SnapshotError("Database snapshot integrity check failed")
    return payload


def sql(mysql, database, query):
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,63}", database):
        raise SnapshotError("Unsupported database name")
    return run(
        [
            "docker",
            "exec",
            "-i",
            mysql,
            *AUTH,
            "mysql",
            "-u",
            "root",
            "--default-character-set=utf8mb4",
            "--batch",
            "--raw",
            "--skip-column-names",
            database,
        ],
        data=query.encode(),
    )


def dump(mysql, database):
    value = run(["docker", "exec", mysql, *AUTH, *DUMP, database])
    if not value or len(value) > MAX_BYTES:
        raise SnapshotError("Missing or oversized database snapshot")
    return value.decode("utf-8")


def project_writers(project):
    ids = run(
        [
            "docker",
            "ps",
            "-aq",
            "--filter",
            f"label=com.docker.compose.project={project}",
        ]
    )
    result = []
    for identity in ids.decode().split():
        item = inspect(identity)
        service = (item["Config"].get("Labels") or {}).get("com.docker.compose.service")
        if service in WRITERS and any(
            environment(item).get(flag, "false").lower() != "false" for flag in FLAGS
        ):
            raise SnapshotError("Disable live execution and scheduling in every source writer")
        if service in WRITERS and item["State"]["Running"]:
            if item["State"].get("Paused"):
                raise SnapshotError("Unpause or stop existing paused writers explicitly")
            result.append(item["Id"])
    return result


def preflight(ops, mysql, *, allow_running=False):
    ops_labels = ops["Config"].get("Labels") or {}
    db_labels = mysql["Config"].get("Labels") or {}
    project = ops_labels.get("com.docker.compose.project")
    if (
        not project
        or ops_labels.get("com.docker.compose.service") != "ops-service"
        or db_labels.get("com.docker.compose.project") != project
        or db_labels.get("com.docker.compose.service") != "ops-mysql"
        or not mysql["State"]["Running"]
    ):
        raise SnapshotError("Select the Ops API and MySQL containers of the same Compose project")
    config = environment(ops)
    db_config = environment(mysql)
    if (
        any(config.get(flag, "false").lower() != "false" for flag in FLAGS)
        or config.get("LLMOPS_ARTIFACT_URL")
        or config.get("DB_NAME") != db_config.get("MYSQL_DATABASE")
        or config.get("DB_HOST") != "ops-mysql"
        or config.get("LLMOPS_RESULTS_DIR") != "/results"
        or config.get("LLMOPS_EVIDENCE_DIR") != "/evaluation-data"
    ):
        raise SnapshotError(
            "Only disabled-live local Compose Ops with filesystem storage is supported"
        )
    if not allow_running and (ops["State"]["Running"] or project_writers(project)):
        raise SnapshotError("Stop ops-service, ops-sync and runner before taking the snapshot")
    database = config["DB_NAME"]
    version = sql(mysql["Id"], database, "SELECT VERSION();").decode().strip()
    if not version.startswith("8.4."):
        raise SnapshotError("Snapshots require MySQL 8.4")
    checks = [
        (
            "SELECT COUNT(*) FROM evaluations_evaluationrun WHERE status NOT IN "
            "('COMPLETED','FAILED','CANCELLED','CRASHED','RESULT_ERROR');"
        ),
        "SELECT COUNT(*) FROM evaluations_evaluationbudgetreservation WHERE closed_at IS NULL;",
        "SELECT COUNT(*) FROM evaluations_evaluationschedule WHERE paused_at IS NULL;",
    ]
    if any(sql(mysql["Id"], database, query).strip() != b"0" for query in checks):
        raise SnapshotError("Finish evaluations/reservations and pause schedules before backup")
    return config


def files(image, mounts, action, data=None):
    return run(
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "--read-only",
            "--user",
            "0:0",
            "--security-opt",
            "no-new-privileges:true",
            *mounts,
            "--entrypoint",
            "python",
            image,
            "-B",
            "-c",
            HELPER,
            action,
        ],
        data=data,
    )


def backup(ops_container, mysql_container, output, key_file, stop_writers=False):
    # Opt-in only: gracefully stop precisely the already-running source writers and
    # restart those same container IDs on success OR failure. Never stop MySQL.
    key_bytes(key_file)
    if output.exists():
        raise SnapshotError("Backup destination already exists; choose a new file")
    if not stop_writers:
        return backup_stopped(ops_container, mysql_container, output, key_file)
    ops, mysql = inspect(ops_container), inspect(mysql_container)
    preflight(ops, mysql, allow_running=True)
    writers = project_writers(ops["Config"]["Labels"]["com.docker.compose.project"])
    attempted = []
    try:
        for identity in writers:
            attempted.append(identity)
            run(["docker", "stop", "--time", "30", identity], timeout=45)
        return backup_stopped(ops["Id"], mysql["Id"], output, key_file)
    finally:
        failed = []
        for identity in reversed(attempted):
            try:
                run(["docker", "start", identity])
            except ValueError:
                failed.append(identity)
        if failed:
            raise SnapshotError(
                "Source writer restart failed; inspect the original Compose services"
            )


def backup_stopped(ops_container, mysql_container, output, key_file):
    key = key_bytes(key_file)
    if output.exists():
        raise SnapshotError("Backup destination already exists; choose a new file")
    ops, mysql = inspect(ops_container), inspect(mysql_container)
    config = preflight(ops, mysql)
    sql_before = dump(mysql["Id"], config["DB_NAME"])
    inventory = json.loads(files(ops["Image"], ["--volumes-from", ops["Id"] + ":ro"], "collect"))
    # Re-check source service state and both stores; do not publish a mixed snapshot.
    preflight(inspect(ops["Id"]), inspect(mysql["Id"]))
    if (
        dump(mysql["Id"], config["DB_NAME"]) != sql_before
        or json.loads(files(ops["Image"], ["--volumes-from", ops["Id"] + ":ro"], "collect"))
        != inventory
    ):
        raise SnapshotError("Source changed during backup; no backup was published")
    payload = {
        "version": 1,
        "database": config["DB_NAME"],
        "ops_image": ops["Image"],
        "mysql_image": mysql["Image"],
        "source_project": ops["Config"]["Labels"]["com.docker.compose.project"],
        "sql": sql_before,
        "sql_sha256": hashlib.sha256(sql_before.encode()).hexdigest(),
        "files": inventory,
        # Keep the receipt verification key. Source DB/session credentials are not reused.
        "budget_token": config.get("LLMOPS_BUDGET_TOKEN", ""),
        "source_core_url": config.get("CORE_API_URL", ""),
    }
    raw = seal(payload, key)
    if unseal(raw, key) != payload:
        raise SnapshotError("Encrypted backup verification failed")
    exclusive(output, raw)
    return {
        "status": "BACKED_UP",
        "sha256": hashlib.sha256(raw).hexdigest(),
        "file_count": len(inventory),
        "model_api_calls": 0,
    }


def compose(directory, *args):
    return run(
        [
            "docker",
            "compose",
            "--project-directory",
            str(directory),
            "--file",
            str(directory / "compose.json"),
            *args,
        ]
    )


def restore_mounts(state, readonly=False):
    return [
        part
        for name, destination in (
            ("results", "/results"),
            ("evidence", "/evaluation-data"),
        )
        for part in (
            "--mount",
            f"type=volume,src={state[name]},dst={destination}" + (",readonly" if readonly else ""),
        )
    ]


def verify_restore(directory, state, payload):
    mysql = inspect(state["mysql_id"])
    if (
        mysql["Id"] != state["mysql_id"]
        or mysql["Image"] != payload["mysql_image"]
        or (mysql["Config"].get("Labels") or {}).get(LABEL) != state["sha256"]
    ):
        raise SnapshotError("Restored database identity changed")
    if dump(mysql["Id"], payload["database"]) != payload["sql"]:
        raise SnapshotError("Restored DB differs from backup; nothing was overwritten")
    actual = json.loads(files(payload["ops_image"], restore_mounts(state, True), "collect"))
    if actual != payload["files"]:
        raise SnapshotError("Restored files differ from backup; nothing was overwritten")
    return {
        "status": "VERIFIED",
        "sha256": state["sha256"],
        "file_count": len(actual),
        "api_started": False,
        "model_api_calls": 0,
    }


def restore(archive, key_file, directory):
    with archive.open("rb") as source:
        raw = source.read(MAX_BYTES * 4 + 1)
    payload = unseal(raw, key_bytes(key_file))
    digest = hashlib.sha256(raw).hexdigest()
    if directory.exists():
        marker = directory / "snapshot-state.json"
        if directory.is_symlink() or not marker.is_file() or marker.is_symlink():
            raise SnapshotError("Target already exists and is not a completed restore")
        state = json.loads(marker.read_text())
        if state.get("sha256") != digest or state.get("complete") is not True:
            raise SnapshotError(
                "Target belongs to another or incomplete restore; use a NEW directory"
            )
        result = verify_restore(directory, state, payload)
        result["status"] = "ALREADY_RESTORED"
        return result
    # Exact source images must be loaded first. Never pull a mutable replacement tag.
    for image in (payload["ops_image"], payload["mysql_image"]):
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
            raise SnapshotError("Snapshot must pin exact Docker images")
        run(["docker", "image", "inspect", image])
    project = "govbiz-ops-restore-" + uuid4().hex[:16]
    state = {
        "sha256": digest,
        "project": project,
        "complete": False,
        "results": project + "-results",
        "evidence": project + "-evidence",
    }
    directory.mkdir(mode=0o700)
    # Never recreate historical reviews through the approval API. Import the DB byte-for-byte.
    password = secrets.token_hex(32)
    mysql_config = {
        "image": payload["mysql_image"],
        "pull_policy": "never",
        "command": ["--event-scheduler=OFF"],
        "labels": {LABEL: digest},
        "environment": {
            "MYSQL_DATABASE": payload["database"],
            "MYSQL_ROOT_PASSWORD": password,
            "MYSQL_USER": "govbiz",
            "MYSQL_PASSWORD": secrets.token_hex(32),
        },
        "volumes": ["database:/var/lib/mysql"],
    }
    api_env = {
        "DJANGO_SECRET_KEY": secrets.token_hex(32),
        "DJANGO_DEBUG": "false",
        "DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1",
        "DB_HOST": "ops-mysql",
        "DB_PORT": "3306",
        "DB_NAME": payload["database"],
        "DB_USER": "govbiz",
        "DB_PASSWORD": mysql_config["environment"]["MYSQL_PASSWORD"],
        "LLMOPS_BUDGET_TOKEN": payload["budget_token"],
        **dict.fromkeys(FLAGS, "false"),
        "LLMOPS_RESULTS_DIR": "/results",
        "LLMOPS_EVIDENCE_DIR": "/evaluation-data",
        # A new Core DB can reuse numeric account IDs for DIFFERENT people. Fail closed until
        # the operator verifies the original Core identities; never map reviewers by email.
        "CORE_API_URL": "http://unconfigured-core.invalid",
        "PREFECT_API_URL": "http://unconfigured-prefect.invalid/api",
        "LANGFUSE_PROJECT_URL": "http://unconfigured-langfuse.invalid",
    }
    config = {
        "name": project,
        "services": {
            "ops-mysql": mysql_config,
            "ops-service": {
                "image": payload["ops_image"],
                "pull_policy": "never",
                "profiles": ["manual-api"],
                "environment": api_env,
                "volumes": ["results:/results:ro", "evidence:/evaluation-data:ro"],
                "ports": ["127.0.0.1:18002:8000"],
            },
        },
        "networks": {"default": {"internal": True}},
        "volumes": {
            "database": {"labels": {LABEL: digest}},
            **{name: {"name": state[name], "external": True} for name in ("results", "evidence")},
        },
    }
    exclusive(directory / "compose.json", json.dumps(config, indent=2).encode())
    exclusive(directory / "snapshot-state.json", json.dumps(state, indent=2).encode())
    compose(directory, "up", "-d", "ops-mysql")
    state["mysql_id"] = compose(directory, "ps", "-q", "ops-mysql").decode().strip()
    state["mysql_id"] = inspect(state["mysql_id"])["Id"]
    deadline = time.monotonic() + 90
    while True:
        try:
            sql(state["mysql_id"], payload["database"], "SELECT 1;")
            break
        except ValueError:
            if time.monotonic() >= deadline:
                raise SnapshotError("New isolated MySQL did not become ready") from None
            time.sleep(1)
    if sql(state["mysql_id"], payload["database"], "SHOW TABLES;").strip():
        raise SnapshotError("Restore target is not empty")
    for name in ("results", "evidence"):
        run(["docker", "volume", "create", "--label", f"{LABEL}={digest}", state[name]])
    files(
        payload["ops_image"],
        restore_mounts(state),
        "restore",
        json.dumps(payload["files"]).encode(),
    )
    sql(state["mysql_id"], payload["database"], payload["sql"])
    result = verify_restore(directory, state, payload)
    state["complete"] = True
    temporary = directory / "snapshot-state.complete.json"
    exclusive(temporary, json.dumps(state, indent=2).encode())
    temporary.replace(directory / "snapshot-state.json")
    result["status"] = "RESTORED"
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    key = actions.add_parser("init-key")
    key.add_argument("--key-file", required=True, type=Path)
    create = actions.add_parser("backup")
    create.add_argument("--ops-container", required=True)
    create.add_argument("--mysql-container", required=True)
    create.add_argument("--output", required=True, type=Path)
    create.add_argument("--key-file", required=True, type=Path)
    create.add_argument(
        "--stop-writers",
        action="store_true",
        help=(
            "Temporarily stop the source Ops API/sync/runner; restart the same containers afterward"
        ),
    )
    load = actions.add_parser("restore")
    load.add_argument("--archive", required=True, type=Path)
    load.add_argument("--key-file", required=True, type=Path)
    load.add_argument("--directory", required=True, type=Path)
    args = vars(parser.parse_args())
    action = args.pop("action")
    try:
        if action == "init-key":
            exclusive(args["key_file"], secrets.token_hex(32).encode() + b"\n")
            result = {"status": "KEY_CREATED"}
        elif action == "backup":
            result = backup(**args)
        else:
            result = restore(**args)
        print(json.dumps(result, sort_keys=True))
    except SnapshotError as error:
        parser.exit(1, f"Snapshot {action} failed: {error}\n")
    except (ValueError, KeyError, TypeError, OSError) as error:
        # No payload/exception repr: even malformed archives may contain private data.
        parser.exit(
            1,
            f"Snapshot {action} failed ({type(error).__name__}); no automatic overwrite.\n",
        )


if __name__ == "__main__":
    main()
