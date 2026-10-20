import descriptor from './manifest.json' with { type: 'json' };
import type { PluginDescriptor } from '@scriptorium-atlas/contracts';

function isPluginDescriptor(value: unknown): value is PluginDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const provides = candidate['provides'];
  const requires = candidate['requires'];
  return candidate['schema'] === 'atlas.plugin/v1'
    && typeof candidate['id'] === 'string'
    && typeof candidate['version'] === 'string'
    && Array.isArray(provides) && provides.every((item) => typeof item === 'string')
    && Array.isArray(requires) && requires.every((item) => typeof item === 'string');
}

if (!isPluginDescriptor(descriptor)) throw new Error('Invalid Atlas plugin manifest metadata.');

/** Lightweight plugin metadata entry. UI and graph dependencies are separate exports. */
export const pluginDescriptor = descriptor;
