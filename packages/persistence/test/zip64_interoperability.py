#!/usr/bin/env python3
"""Validate the max-cap Atlas bundle with Python's independent ZIP reader."""

import hashlib
import json
import platform
import sys
import zipfile
from pathlib import Path


EXPECTED_ARCHIVE_BYTES = 14_682_752
EXPECTED_ARCHIVE_SHA256 = "b6f577a073a19b215bc4769828eec3b9d6665863894d9941ae82b4073dc0226b"
EXPECTED_TAIL_SHA256 = "a91cb96bf7dbf3cb9516ed8098df80a916b79c245a189e9603122e87ae5a44f7"
TAIL_PATH = "workspace/payload/file-099998.bin"
TAIL_BYTES = b"ZIP64 Python interoperability tail\n"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"Usage: {sys.argv[0]} /path/to/archive.zip")

    archive = Path(sys.argv[1]).resolve(strict=True)
    archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert archive.stat().st_size == EXPECTED_ARCHIVE_BYTES
    assert archive_hash == EXPECTED_ARCHIVE_SHA256

    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        assert len(names) == 100_000, len(names)
        assert len(set(names)) == 100_000, "ZIP contains duplicate member names"
        assert names[0] == "manifest.json"
        manifest_bytes = bundle.read("manifest.json")
        manifest = json.loads(manifest_bytes)
        assert manifest["workspaceId"] == "python-zip64-interop"
        assert len(manifest["files"]) == 99_999

        tail = bundle.read(TAIL_PATH)
        assert tail == TAIL_BYTES
        tail_manifest_item = next(item for item in manifest["files"] if item["path"] == "payload/file-099998.bin")
        tail_hash = hashlib.sha256(tail).hexdigest()
        assert tail_hash == EXPECTED_TAIL_SHA256
        assert tail_hash == tail_manifest_item["sha256"]
        assert bundle.testzip() is None, "ZIP member CRC validation failed"

    print(json.dumps({
        "python": platform.python_version(),
        "archiveBytes": archive.stat().st_size,
        "archiveSha256": archive_hash,
        "zipEntries": len(names),
        "manifestBytes": len(manifest_bytes),
        "manifestPayloadFiles": len(manifest["files"]),
        "tailPath": TAIL_PATH,
        "tailSha256": tail_hash,
        "testzip": None,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
