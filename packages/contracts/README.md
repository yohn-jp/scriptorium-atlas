# @scriptorium-atlas/contracts

Public, versioned schema-derived contracts shared by Atlas plugins and their Host. The canonical JSON Schema lives at `docs/contracts/v1.schema.json`; run `pnpm generate` to produce TypeScript types, validators, and the packaged schema copy.

Import domain contracts from the package root or the `/provider`, `/host`, and `/documents` public subpaths. Plugin frame code receives `PluginHostClient`; Host-only commit, recovery, and export methods are not part of that client.
