import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const profile = process.env.ATLAS_PROFILE ?? 'combined';
if (!['atlas', 'story', 'combined'].includes(profile)) throw new Error('Invalid ATLAS_PROFILE');
const enabled = profile === 'combined' ? ['atlas', 'story'] : [profile];
const packages = { atlas: '@scriptorium-atlas/atlas', story: '@scriptorium-atlas/story-knowledge' };

function composition(): Plugin {
  return {
    name: 'atlas-profile-closure',
    resolveId(id) { if (id === 'virtual:atlas-profile') return '\0atlas-profile'; },
    load(id) {
      if (id !== '\0atlas-profile') return;
      return `${enabled.map(key => `import * as ${key}Metadata from '${packages[key as keyof typeof packages]}/metadata';`).join('\n')}
        export const profile=${JSON.stringify(profile)};
        export const metadata={${enabled.map(key => `${key}:${key}Metadata`).join(',')}};
        export const loaders={${enabled.map(key => `${key}:()=>import('${packages[key as keyof typeof packages]}/ui')`).join(',')}};
        export const providerLoaders={${enabled.includes('story') ? "story:()=>import('@scriptorium-atlas/story-knowledge/provider')" : ''}};`;
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(x => x.type === 'chunk').map(x => ({
        file: x.fileName, imports: x.imports, dynamicImports: x.dynamicImports,
        modules: Object.keys(x.modules).map(path => path.replace(/^.*\/node_modules\//, 'node_modules/').replace(/^.*\/scriptorium-atlas[^/]*\//, '')),
        bytes: new TextEncoder().encode(x.code).length,
      }));
      const modules = chunks.flatMap(x => x.modules);
      const forbidden = profile === 'story' ? /excalidraw|xyflow|packages\/layout|plugins\/atlas\// : profile === 'atlas' ? /plugins\/story-knowledge|node_modules\/yaml\// : /$^/;
      if (modules.some(path => forbidden.test(path))) this.error(`Forbidden module in ${profile} closure`);
      this.emitFile({ type: 'asset', fileName: 'closure.json', source: JSON.stringify({ profile, chunks }, null, 2) + '\n' });
    },
  };
}

export default defineConfig({
  plugins: [composition()],
  define: { __ATLAS_PROFILE__: JSON.stringify(profile) },
  build: {
    outDir: `../../dist/${profile}`, emptyOutDir: true, sourcemap: true,
    rollupOptions: { input: { host: fileURLToPath(new URL('index.html', import.meta.url)), frame: fileURLToPath(new URL('frame.html', import.meta.url)) } },
  },
  worker: { format: 'es' },
});
