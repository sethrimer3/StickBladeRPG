/**
 * decorativeObjectCatalogue.ts — Build-time discovery for decorative object sprites.
 *
 * Sprites placed in ASSETS/SPRITES/DecorativeObjects/ are automatically discovered
 * and exposed in the editor as placeable decorative objects.
 *
 * The in-game name in the editor is the file name without extension.
 */

export interface DecorativeObjectOption {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly filename: string;
}

const _IS_VITE_RUNTIME = import.meta.env?.BASE_URL !== undefined;
const BASE = import.meta.env?.BASE_URL ?? '';

const _DECORATIVE_OBJECTS_GLOB: Record<string, unknown> = _IS_VITE_RUNTIME
  ? import.meta.glob(
      '/ASSETS/SPRITES/DecorativeObjects/*.{png,webp,jpg,jpeg}',
      { query: '?url', import: 'default' },
    )
  : {};

const _DECORATIVE_FILE_RE = /^\/ASSETS\/SPRITES\/DecorativeObjects\/([^/]+)\.(png|webp|jpg|jpeg)$/i;

function _stripExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

function _buildDecorativeObjectOptions(): DecorativeObjectOption[] {
  const discovered: DecorativeObjectOption[] = [];

  for (const fullPath of Object.keys(_DECORATIVE_OBJECTS_GLOB)) {
    const match = _DECORATIVE_FILE_RE.exec(fullPath);
    if (match === null) continue;

    const filename = fullPath.slice(fullPath.lastIndexOf('/') + 1);
    const id = _stripExtension(filename);
    const publicUrl = `${BASE}${fullPath.slice('/ASSETS/'.length)}`;
    discovered.push({ id, label: id, url: publicUrl, filename });
  }

  // If running in a non-Vite test environment where globbing is unavailable,
  // register default known assets so tests have a valid catalogue.
  if (discovered.length === 0) {
    discovered.push({
      id: 'OakTree1',
      label: 'OakTree1',
      url: `${BASE}SPRITES/DecorativeObjects/OakTree1.png`,
      filename: 'OakTree1.png',
    });
  }

  discovered.sort((a, b) => a.label.localeCompare(b.label));
  return discovered;
}

export const DECORATIVE_OBJECT_OPTIONS: readonly DecorativeObjectOption[] = _buildDecorativeObjectOptions();

const _DECORATIVE_BY_ID = new Map(DECORATIVE_OBJECT_OPTIONS.map(option => [option.id, option]));

export function getDecorativeObjectOption(id: string): DecorativeObjectOption | undefined {
  return _DECORATIVE_BY_ID.get(id);
}

export function getDecorativeObjectSpriteUrl(id: string): string | null {
  const opt = _DECORATIVE_BY_ID.get(id);
  if (opt !== undefined) return opt.url;
  // Fallback direct URL format
  return `${BASE}SPRITES/DecorativeObjects/${id}.png`;
}

export function isDecorativeObjectAvailable(id: string): boolean {
  return _DECORATIVE_BY_ID.has(id);
}
