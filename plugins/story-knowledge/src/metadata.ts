import type { PluginDescriptor, ProviderDescriptor } from "@scriptorium-atlas/contracts";

/** Static manifest metadata. This module is safe to load before the Story UI or parser. */
export const pluginDescriptor = Object.freeze({
  schema: "atlas.plugin/v1",
  id: "scriptorium.story-knowledge",
  version: "1.0.0",
  provides: ["atlas.graph/v1", "story-knowledge/ui/v1"],
  requires: ["workspace.files.metadata", "workspace.files.read", "workspace.files.prepare", "source.open"],
}) satisfies PluginDescriptor;

const providerDescriptorValue: ProviderDescriptor = {
  id: "scriptorium.story-knowledge",
  schemaVersion: "atlas.graph/v1",
  version: "1.0.0",
  features: ["listNodes", "listEdges", "getNodes", "neighbors", "diff", "updated"],
  requiredReadCapabilities: ["workspace.files.metadata", "workspace.files.read", "graph.read"],
};
export const providerDescriptor: ProviderDescriptor = Object.freeze(providerDescriptorValue);

export function describeStoryProvider(): ProviderDescriptor {
  return providerDescriptor;
}
