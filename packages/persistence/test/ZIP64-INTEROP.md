# ZIP64 interoperability evidence

This check exports the maximum supported workspace using the persistence implementation, then validates the archive with Python's independent standard-library `zipfile` reader. The workspace contains 99,999 payload files plus the reserved `manifest.json` entry. The last payload is nonempty so the oracle checks both ZIP64 entry counting and actual member data.

Run from `packages/persistence` after installing the package dependencies. The test refuses an output path inside the repository and writes only to the supplied absolute path. The Python oracle prints the measured archive metadata.

```sh
mkdir -p /tmp/atlas-v1-zip64
export ATLAS_BUNDLE_OUTPUT=/tmp/atlas-v1-zip64/max-cap.zip
pnpm exec vitest run test/zip64-interoperability.test.ts
python3 test/zip64_interoperability.py "$ATLAS_BUNDLE_OUTPUT"
```

The Python oracle checks the ZIP entry count, uniqueness of member names, parsed manifest count, the final nonempty payload and its manifest SHA-256, archive size and SHA-256, and CRCs for every member via `ZipFile.testzip()`. It prints a JSON result and exits nonzero on any mismatch.

The independent run completed with Python 3.13.15 and produced:

```json
{
  "archiveBytes": 14682752,
  "archiveSha256": "b6f577a073a19b215bc4769828eec3b9d6665863894d9941ae82b4073dc0226b",
  "manifestBytes": 12100079,
  "manifestPayloadFiles": 99999,
  "python": "3.13.15",
  "tailPath": "workspace/payload/file-099998.bin",
  "tailSha256": "a91cb96bf7dbf3cb9516ed8098df80a916b79c245a189e9603122e87ae5a44f7",
  "testzip": null,
  "zipEntries": 100000
}
```

The ZIP itself is deliberately not stored in the repository.
