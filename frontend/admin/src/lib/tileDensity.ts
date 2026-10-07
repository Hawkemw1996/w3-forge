// =============================================================================
// tileDensity — v0.5.3.1
// =============================================================================
//
// Maps a react-grid-layout tile size (w/h in grid units) to one of three
// density modes. Widgets read this mode to decide how much detail to render
// inside their body so content fits within the tile boundary instead of
// spilling outside it.
//
// Rules (per v0.5.3.1 spec):
//   compact  — h <= 2 OR w <= 3   (tile is short OR narrow)
//   expanded — h >= 5 OR w >= 6   (tile is tall OR wide)
//   standard — everything else (the typical 4x4 / 4x3 case)
//
// This is intentionally a simple helper. It does not measure pixel sizes,
// it does not react to ResizeObserver. The grid item w/h is the single
// source of truth.

export type TileDensity = 'compact' | 'standard' | 'expanded';

export interface TileSize {
  w: number;
  h: number;
}

export function getTileDensity(size: TileSize | undefined | null): TileDensity {
  if (!size) return 'standard';
  const { w, h } = size;
  if (h <= 2 || w <= 3) return 'compact';
  if (h >= 5 || w >= 6) return 'expanded';
  return 'standard';
}
