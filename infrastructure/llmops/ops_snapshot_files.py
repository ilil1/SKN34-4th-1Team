"""Networkless container helper for bounded, link-free Ops result/evidence copies."""

import base64
import hashlib
import json
import os
import stat
import sys
from pathlib import Path, PurePosixPath

MAX_BYTES = 128 * 1024 * 1024
MAX_FILES = 10000
ROOTS = {"results": Path("/results"), "evidence": Path("/evaluation-data")}


def validate(files):
    if not isinstance(files, dict) or not files or len(files) > MAX_FILES:
        raise ValueError("Invalid snapshot file inventory")
    total = 0
    for name, row in files.items():
        path = PurePosixPath(name)
        if (
            path.as_posix() != name
            or path.is_absolute()
            or len(path.parts) < 2
            or path.parts[0] not in ROOTS
            or any(part in {".", ".."} for part in path.parts)
            or "\\" in name
            or "\x00" in name
        ):
            raise ValueError("Invalid snapshot file path")
        raw = base64.b64decode(row["data"], validate=True)
        total += len(raw)
        if (
            total > MAX_BYTES
            or hashlib.sha256(raw).hexdigest() != row["sha256"]
            or any(type(row[key]) is not int or row[key] < 0 for key in ("mode", "uid", "gid"))
            or row["mode"] > 0o777
        ):
            raise ValueError("Snapshot file integrity check failed")
    # Reject a file used as another file's directory before touching the target.
    if any(str(parent) in files for name in files for parent in PurePosixPath(name).parents):
        raise ValueError("Conflicting snapshot paths")
    return files


def collect():
    files = {}
    total = 0
    for label, root in ROOTS.items():
        if root.is_symlink() or not root.is_dir():
            raise ValueError("Missing regular snapshot root")
        for path in sorted(root.rglob("*")):
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o7000:
                raise ValueError("Links and special files cannot be backed up")
            total += info.st_size
            if total > MAX_BYTES or len(files) >= MAX_FILES:
                raise ValueError("Snapshot exceeds the supported size")
            raw = path.read_bytes()
            files[label + "/" + path.relative_to(root).as_posix()] = {
                "data": base64.b64encode(raw).decode(),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "mode": stat.S_IMODE(info.st_mode),
                "uid": info.st_uid,
                "gid": info.st_gid,
            }
    return validate(files)


def restore(files):
    validate(files)
    for root in ROOTS.values():
        if root.is_symlink() or not root.is_dir() or any(root.iterdir()):
            raise ValueError("Restore needs empty, separate volume roots")
    for name, row in files.items():
        prefix, relative = name.split("/", 1)
        destination = ROOTS[prefix] / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as output:
            output.write(base64.b64decode(row["data"], validate=True))
        os.chmod(destination, row["mode"])
        os.chown(destination, row["uid"], row["gid"])
    if collect() != files:
        raise ValueError("Restored files do not match the snapshot")


if __name__ == "__main__":
    if sys.argv[1] == "collect":
        print(json.dumps(collect(), sort_keys=True))
    elif sys.argv[1] == "restore":
        restore(json.load(sys.stdin))
        print("restored")
    else:
        raise ValueError("Unknown file operation")
