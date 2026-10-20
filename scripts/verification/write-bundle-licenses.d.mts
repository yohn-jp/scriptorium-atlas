export type AtlasProfile = 'atlas' | 'story' | 'combined';

export interface BundleModuleReference {
  path?: string;
  id?: string;
  source?: string;
}

export interface BundleClosureChunk {
  file?: string;
  modules: Array<string | BundleModuleReference>;
}

export interface BundleClosure {
  chunks: BundleClosureChunk[];
}

export interface BundleDependency {
  packageInfo: {
    name: string;
    version: string;
    directory: string;
    manifest: Record<string, unknown>;
  };
  modules: string[];
}

export declare function bundleDependencyClosure(args: {
  repoRoot: string;
  closure: BundleClosure;
}): Promise<BundleDependency[]>;

export declare function verifiedLicenseSupplement(packageInfo: BundleDependency['packageInfo']): Promise<{
  entry: Record<string, unknown>;
  source: Record<string, unknown>;
  content: Uint8Array;
  provenance: Record<string, unknown>;
} | null>;

export declare function writeBundleLicenses(args: {
  repoRoot: string;
  profile: AtlasProfile;
  closure: BundleClosure;
  outputDirectory?: string;
}): Promise<{
  manifestPath: string;
  packageCount: number;
  assetCount: number;
}>;
