declare const __ATLAS_PROFILE__: 'atlas' | 'story' | 'combined';
declare module 'virtual:atlas-profile' {
  export const profile: 'atlas' | 'story' | 'combined';
  export const loaders: Record<string, () => Promise<unknown>>;
  export const providerLoaders: Record<string, () => Promise<unknown>>;
  export const metadata: Record<string, {pluginDescriptor: import('@scriptorium-atlas/contracts').PluginDescriptor; providerDescriptor?: import('@scriptorium-atlas/contracts').ProviderDescriptor}>;
}
