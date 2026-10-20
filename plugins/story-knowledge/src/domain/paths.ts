import type { StoryEntityType } from "./types.js";

const YAML_EXT = String.raw`(?:\.yaml|\.yml)`;

const ENTITY_PREFIXES: ReadonlyArray<readonly [RegExp, StoryEntityType]> = [
  [/^bible\/characters\/.+\.ya?ml$/i, "character"],
  [/^bible\/locations\/.+\.ya?ml$/i, "location"],
  [/^bible\/factions\/.+\.ya?ml$/i, "faction"],
  [/^bible\/items\/.+\.ya?ml$/i, "item"],
  [/^bible\/timeline\/events\/.+\.ya?ml$/i, "event"],
  [/^bible\/lore\/.+\.ya?ml$/i, "lore"],
  [/^bible\/dialogue_sketches\/.+\.ya?ml$/i, "dialogue_sketch"],
  [/^plot\/threads\/.+\.ya?ml$/i, "thread"],
  [/^plot\/arcs\/.+\.ya?ml$/i, "arc"],
  [/^plot\/volumes\/[^/]+\/volume\.ya?ml$/i, "volume"],
  [/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.ya?ml$/i, "chapter"],
  [/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.ya?ml$/i, "scene"],
];

export function normalizeStoryPath(path: string): string | null {
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || path.includes("\\") || path.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return path;
}

export function inferStoryType(path: string): StoryEntityType | null {
  if (/^manuscript\/.+\.md$/i.test(path)) return "manuscript";
  for (const [pattern, type] of ENTITY_PREFIXES) {
    if (pattern.test(path)) return type;
  }
  return null;
}

export function isStorySourcePath(path: string): boolean {
  return inferStoryType(path) !== null;
}

export function pathSupportsType(path: string, type: StoryEntityType): boolean {
  return inferStoryType(path) === type;
}

export function defaultStoryPath(type: Exclude<StoryEntityType, "dialogue_sketch">, id: string, parents?: {
  volumeId?: string;
  chapterId?: string;
}): string {
  switch (type) {
    case "character":
      return `bible/characters/${id}/profile.yaml`;
    case "location":
      return `bible/locations/${id}.yaml`;
    case "faction":
      return `bible/factions/${id}.yaml`;
    case "item":
      return `bible/items/${id}.yaml`;
    case "event":
      return `bible/timeline/events/${id}.yaml`;
    case "lore":
      return `bible/lore/${id}.yaml`;
    case "thread":
      return `plot/threads/${id}.yaml`;
    case "arc":
      return `plot/arcs/${id}.yaml`;
    case "volume":
      return `plot/volumes/${id}/volume.yaml`;
    case "chapter":
      if (!parents?.volumeId) throw new Error("A chapter requires a volumeId.");
      return `plot/volumes/${parents.volumeId}/chapters/${id}/chapter.yaml`;
    case "scene":
      if (!parents?.volumeId || !parents.chapterId) throw new Error("A scene requires volumeId and chapterId.");
      return `plot/volumes/${parents.volumeId}/chapters/${parents.chapterId}/scenes/${id}.yaml`;
    case "manuscript":
      return `manuscript/${id}.md`;
  }
}

export function hierarchyParents(path: string): { volumePathId?: string; chapterPathId?: string } {
  const match = /^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/(?:chapter\.ya?ml|scenes\/[^/]+\.ya?ml)$/i.exec(path);
  if (!match) return {};
  return { ...(match[1] ? { volumePathId: match[1] } : {}), ...(path.toLowerCase().includes("/scenes/") && match[2] ? { chapterPathId: match[2] } : {}) };
}

export function sourcePathToManuscriptId(path: string): string {
  // Keep the identity opaque and stable for legacy files that have no frontmatter ID.
  // The path remains the source identity; the value is never used to rewrite that path.
  return `manuscript-${encodeURIComponent(path).replaceAll("%", "_")}`;
}

export function getYamlExtension(path: string): string | null {
  return new RegExp(`${YAML_EXT}$`, "i").exec(path)?.[0] ?? null;
}
