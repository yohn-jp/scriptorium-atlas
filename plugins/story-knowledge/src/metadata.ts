import type { PluginDescriptor } from "@scriptorium-atlas/contracts/host";
import type { ProviderDescriptor } from "@scriptorium-atlas/contracts/provider";

/** Static manifest metadata. This module is safe to load before the Story UI or parser. */
export const pluginDescriptor: PluginDescriptor = Object.freeze({
  schema: "atlas.plugin/v1",
  id: "scriptorium.story-knowledge",
  version: "1.0.0",
  provides: ["atlas.graph/v1", "story-knowledge/ui/v1"],
  requires: ["workspace.files.metadata", "workspace.files.read", "workspace.files.prepare", "source.open"],
});

export const providerDescriptor: ProviderDescriptor = Object.freeze({
  id: "scriptorium.story-knowledge",
  schemaVersion: "atlas.graph/v1",
  version: "1.0.0",
  features: ["listNodes", "listEdges", "getNodes", "neighbors", "diff", "updated"],
  requiredReadCapabilities: ["workspace.files.metadata", "workspace.files.read", "source.open", "graph.read"],
});

export function describeStoryProvider(): ProviderDescriptor {
  return providerDescriptor;
}
