import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {writeBundleLicenses} from '../../scripts/verification/write-bundle-licenses.mjs';

const profileValue = process.env['ATLAS_PROFILE'] ?? 'combined';
if (profileValue!=='atlas'&&profileValue!=='story'&&profileValue!=='combined') throw new Error('Invalid ATLAS_PROFILE');
const profile=profileValue;
const enabled = profile === 'combined' ? ['atlas', 'story'] : [profile];
const packages = { atlas: '@scriptorium-atlas/atlas', story: '@scriptorium-atlas/story-knowledge' };
const repoRoot=resolve(fileURLToPath(new URL('.',import.meta.url)),'../..');
type ClosureChunk={file:string;imports:string[];dynamicImports:string[];workerImports:string[];workerEntry:boolean;modules:string[];bytes:number};
const workerChunks:ClosureChunk[]=[];
const modulePath=(path:string)=>path.startsWith('\0')?`<virtual>${path.slice(1)}`:relative(repoRoot,path);

function composition(): Plugin {
  let closure:{chunks:ClosureChunk[]}|undefined;
  return {
    name: 'atlas-profile-closure',
    buildStart(){workerChunks.length=0;},
    resolveId(id) { if (id === 'virtual:atlas-profile') return '\0atlas-profile'; },
    load(id) {
      if (id !== '\0atlas-profile') return;
      return `${enabled.map(key => `import * as ${key}Metadata from '${packages[key as keyof typeof packages]}/metadata';`).join('\n')}
        export const profile=${JSON.stringify(profile)};
        export const metadata={${enabled.map(key => `${key}:${key}Metadata`).join(',')}};
        export const loaders={${enabled.map(key => key==='atlas'
          ? "atlas:async()=>{const canvas=await import('@scriptorium-atlas/canvas');canvas.configureExcalidrawAssets('/');return import('@scriptorium-atlas/atlas/ui')}"
          : `${key}:()=>import('${packages[key as keyof typeof packages]}/ui')`).join(',')}};
        export const providerLoaders={${enabled.includes('story') ? "story:()=>import('@scriptorium-atlas/story-knowledge/provider')" : ''}};`;
    },
    generateBundle(_options, bundle) {
      const chunks = [...workerChunks,...Object.values(bundle).filter(x => x.type === 'chunk').map(x => ({
        file: x.fileName, imports: x.imports, dynamicImports: x.dynamicImports, workerImports:[],workerEntry:false,
        modules: Object.keys(x.modules).map(modulePath),
        bytes: new TextEncoder().encode(x.code).length,
      }))];
      const modules = chunks.flatMap(x => x.modules);
      const forbidden = profile === 'story' ? /excalidraw|xyflow|packages\/layout|plugins\/atlas\// : profile === 'atlas' ? /plugins\/story-knowledge|node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?yaml\// : /$^/;
      if (modules.some(path => forbidden.test(path))) this.error(`Forbidden module in ${profile} closure`);
      closure={chunks};
      this.emitFile({ type: 'asset', fileName: 'closure.json', source: JSON.stringify({ profile, chunks }, null, 2) + '\n' });
    },
    async closeBundle() {
      if (!closure) throw new Error('Bundle closure not generated');
      const outputDirectory=resolve(repoRoot,'dist',profile);
      const workerEntries=closure.chunks.filter(chunk=>chunk.workerEntry);
      for (const chunk of closure.chunks) {
        const emitted=await readFile(resolve(outputDirectory,chunk.file));
        chunk.bytes=emitted.byteLength;
        const code=emitted.toString('utf8');
        chunk.workerImports=workerEntries.filter(worker=>{
          const path=worker.file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
          return new RegExp(String.raw`new\s+Worker\s*\(\s*new\s+URL\s*\(\s*['"\x60]/?${path}['"\x60]`).test(code);
        }).map(worker=>worker.file);
      }
      await writeFile(resolve(outputDirectory,'closure.json'),JSON.stringify({profile,...closure},null,2)+'\n');
      if (profile!=='story') {
        const {copyCanvasAssets} = await import('@scriptorium-atlas/canvas/assets');
        await copyCanvasAssets(outputDirectory);
      }
      await writeBundleLicenses({repoRoot,profile,closure,outputDirectory});
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
  worker: { format: 'es',plugins:()=>[{
    name:'atlas-worker-inventory',
    generateBundle(_options,bundle){
      for(const chunk of Object.values(bundle)) if(chunk.type==='chunk') workerChunks.push({file:chunk.fileName,imports:chunk.imports,dynamicImports:chunk.dynamicImports,workerImports:[],workerEntry:chunk.isEntry,modules:Object.keys(chunk.modules).map(modulePath),bytes:new TextEncoder().encode(chunk.code).length});
    },
  }] },
});
