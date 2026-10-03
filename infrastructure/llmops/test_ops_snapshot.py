"""Free snapshot boundary checks; real MySQL/file round trips have a separate smoke."""

import base64
import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ops_snapshot as snapshot
import ops_snapshot_files as storage


def example_files():
    raw = "E01 사람 검토 근거 🧪".encode()
    return {
        "results/run/review.json": {
            "data": base64.b64encode(raw).decode(),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "mode": 0o640,
            "uid": os.getuid(),
            "gid": os.getgid(),
        }
    }


def payload():
    sql = "검토 사유·승인자·예산·기준 원본 SQL"
    return {
        "version": 1,
        "files": example_files(),
        "sql": sql,
        "sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
    }


class EncryptionTests(unittest.TestCase):
    def setUp(self):
        self.key = b"a" * 64 + b"\n"

    def test_real_openssl_round_trip_and_randomized_ciphertext(self):
        first = snapshot.seal(payload(), self.key)
        second = snapshot.seal(payload(), self.key)
        self.assertNotEqual(first, second)
        self.assertNotIn("검토".encode(), first)
        self.assertEqual(snapshot.unseal(first, self.key), payload())

    def test_tampering_wrong_key_and_truncation_fail_before_decryption(self):
        raw = snapshot.seal(payload(), self.key)
        invalid = [raw[:-1], raw + b"x", raw[:-1] + bytes([raw[-1] ^ 1]), b"garbage"]
        with patch.object(snapshot, "crypt", side_effect=AssertionError("Must authenticate first")):
            for value in invalid:
                with self.subTest(value=len(value)), self.assertRaises(ValueError):
                    snapshot.unseal(value, self.key)
            with self.assertRaises(ValueError):
                snapshot.unseal(raw, b"b" * 64 + b"\n")

    def test_database_digest_must_match(self):
        value = payload()
        value["sql"] += "modified"
        with self.assertRaisesRegex(ValueError, "Database snapshot integrity"):
            snapshot.unseal(snapshot.seal(value, self.key), self.key)

    def test_key_permissions_links_and_existing_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            key = root / "key"
            snapshot.exclusive(key, self.key)
            self.assertEqual(snapshot.key_bytes(key), self.key)
            with self.assertRaises(FileExistsError):
                snapshot.exclusive(key, b"replacement")
            key.chmod(0o644)
            with self.assertRaises(ValueError):
                snapshot.key_bytes(key)
            link = root / "link"
            link.symlink_to(key)
            with self.assertRaises(OSError):
                snapshot.key_bytes(link)


class FileTests(unittest.TestCase):
    def test_paths_and_digests_are_checked_before_any_write(self):
        for name in (
            "/results/x",
            "results/../x",
            "results//x",
            "results/./x",
            "elsewhere/x",
            "results/a\\b",
            "results",
        ):
            value = {name: next(iter(example_files().values()))}
            with self.subTest(name=name), self.assertRaises(ValueError):
                storage.validate(value)
        value = example_files()
        value["results/run/review.json"]["data"] = base64.b64encode(b"modified").decode()
        with self.assertRaisesRegex(ValueError, "integrity"):
            storage.validate(value)

    def test_overlapping_files_and_special_permissions_rejected(self):
        files = example_files()
        files["results/run"] = files["results/run/review.json"]
        with self.assertRaises(ValueError):
            storage.validate(files)
        files = example_files()
        files["results/run/review.json"]["mode"] = 0o4755
        with self.assertRaises(ValueError):
            storage.validate(files)

    def test_file_round_trip_and_existing_target_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            roots = {name: Path(temporary) / name for name in storage.ROOTS}
            for root in roots.values():
                root.mkdir()
            with patch.object(storage, "ROOTS", roots):
                storage.restore(example_files())
                self.assertEqual(storage.collect(), example_files())
                with self.assertRaisesRegex(ValueError, "empty"):
                    storage.restore(example_files())
                self.assertEqual(storage.collect(), example_files())

    def test_symlinks_hardlinks_and_oversized_files_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "one"
            source.write_text("file")
            with patch.object(storage, "ROOTS", {"results": root}):
                link = root / "link"
                link.symlink_to(source)
                with self.assertRaises(ValueError):
                    storage.collect()
                link.unlink()
                os.link(source, link)
                with self.assertRaises(ValueError):
                    storage.collect()
                link.unlink()
                with (
                    patch.object(storage, "MAX_BYTES", 1),
                    self.assertRaises(ValueError),
                ):
                    storage.collect()


class PreflightTests(unittest.TestCase):
    def setUp(self):
        labels = {
            "com.docker.compose.project": "source",
            "com.docker.compose.service": "ops-service",
        }
        self.ops = {
            "Id": "ops",
            "State": {"Running": False},
            "Config": {
                "Labels": labels,
                "Env": [
                    "DB_NAME=ops",
                    "DB_HOST=ops-mysql",
                    "LLMOPS_RESULTS_DIR=/results",
                    "LLMOPS_EVIDENCE_DIR=/evaluation-data",
                ],
            },
        }
        self.mysql = copy.deepcopy(self.ops)
        self.mysql["Id"] = "mysql"
        self.mysql["State"]["Running"] = True
        self.mysql["Config"]["Labels"]["com.docker.compose.service"] = "ops-mysql"
        self.mysql["Config"]["Env"] = ["MYSQL_DATABASE=ops"]

    def test_stopped_quiet_source_is_accepted(self):
        with (
            patch.object(snapshot, "run", return_value=b""),
            patch.object(snapshot, "sql", side_effect=[b"8.4.9", b"0", b"0", b"0"]),
        ):
            self.assertEqual(snapshot.preflight(self.ops, self.mysql)["DB_NAME"], "ops")

    def test_running_source_writer_is_rejected(self):
        for service in snapshot.WRITERS:
            writer = copy.deepcopy(self.ops)
            writer["State"]["Running"] = True
            writer["Config"]["Labels"]["com.docker.compose.service"] = service
            with (
                patch.object(snapshot, "run", return_value=b"writer"),
                patch.object(snapshot, "inspect", return_value=writer),
                self.subTest(service=service),
                self.assertRaisesRegex(ValueError, "Stop"),
            ):
                snapshot.preflight(self.ops, self.mysql)

    def test_remote_storage_live_active_runs_reservations_schedules_rejected(self):
        for setting in (
            *[name + "=true" for name in snapshot.FLAGS],
            "LLMOPS_ARTIFACT_URL=http://remote",
        ):
            ops = copy.deepcopy(self.ops)
            ops["Config"]["Env"].append(setting)
            with self.subTest(setting=setting), self.assertRaises(ValueError):
                snapshot.preflight(ops, self.mysql)
        for count in range(3):
            responses = [b"8.4.9"] + [b"0"] * count + [b"1"]
            with (
                patch.object(snapshot, "run", return_value=b""),
                patch.object(snapshot, "sql", side_effect=responses),
                self.assertRaisesRegex(ValueError, "Finish"),
            ):
                snapshot.preflight(self.ops, self.mysql)


class RetryTests(unittest.TestCase):
    def test_opt_in_stop_restores_only_original_writers_even_when_backup_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            ops = {
                "Id": "ops",
                "Config": {"Labels": {"com.docker.compose.project": "original"}},
            }
            with (
                patch.object(snapshot, "key_bytes"),
                patch.object(snapshot, "inspect", side_effect=[ops, {"Id": "mysql"}]),
                patch.object(snapshot, "preflight") as preflight,
                patch.object(snapshot, "project_writers", return_value=["api", "sync"]),
                patch.object(snapshot, "backup_stopped", side_effect=ValueError("copy failed")),
                patch.object(snapshot, "run") as command,
                self.assertRaisesRegex(ValueError, "copy failed"),
            ):
                snapshot.backup("api", "mysql", Path(temporary) / "out", Path("key"), True)
            preflight.assert_called_once_with(ops, {"Id": "mysql"}, allow_running=True)
            self.assertEqual(
                [call.args[0] for call in command.call_args_list],
                [
                    ["docker", "stop", "--time", "30", "api"],
                    ["docker", "stop", "--time", "30", "sync"],
                    ["docker", "start", "sync"],
                    ["docker", "start", "api"],
                ],
            )

    def test_default_backup_never_stops_any_container(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(snapshot, "key_bytes"),
            patch.object(snapshot, "backup_stopped", return_value={"status": "BACKED_UP"}),
            patch.object(snapshot, "run") as command,
        ):
            self.assertEqual(
                snapshot.backup("ops", "db", Path(temporary) / "out", Path("key")),
                {"status": "BACKED_UP"},
            )
            command.assert_not_called()

    def test_existing_arbitrary_or_incomplete_destination_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            archive = target / "snapshot.enc"
            archive.write_bytes(b"encrypted")
            sentinel = target / "precious.txt"
            sentinel.write_text("existing")
            with (
                patch.object(snapshot, "key_bytes"),
                patch.object(snapshot, "unseal", return_value=payload()),
                patch.object(snapshot, "run") as command,
            ):
                with self.assertRaisesRegex(ValueError, "already exists"):
                    snapshot.restore(archive, Path("key"), target)
                (target / "snapshot-state.json").write_text(json.dumps({"complete": False}))
                with self.assertRaisesRegex(ValueError, "incomplete"):
                    snapshot.restore(archive, Path("key"), target)
                command.assert_not_called()
                self.assertEqual(sentinel.read_text(), "existing")

    def test_same_archive_rechecks_stores_without_import_or_recreating_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            archive = target / "snapshot.enc"
            archive.write_bytes(b"encrypted")
            state = {
                "sha256": hashlib.sha256(b"encrypted").hexdigest(),
                "complete": True,
            }
            (target / "snapshot-state.json").write_text(json.dumps(state))
            with (
                patch.object(snapshot, "key_bytes"),
                patch.object(snapshot, "unseal", return_value=payload()),
                patch.object(snapshot, "run") as command,
                patch.object(
                    snapshot, "verify_restore", return_value={"status": "VERIFIED"}
                ) as verify,
            ):
                self.assertEqual(
                    snapshot.restore(archive, Path("key"), target)["status"],
                    "ALREADY_RESTORED",
                )
                verify.assert_called_once_with(target, state, payload())
                command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
