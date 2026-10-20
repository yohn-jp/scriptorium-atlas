import descriptor from './manifest.json' with { type: 'json' };
import type { PluginDescriptor } from '@scriptorium-atlas/contracts';

/** Lightweight plugin metadata entry. UI and graph dependencies are separate exports. */
export const pluginDescriptor = descriptor satisfies PluginDescriptor;
