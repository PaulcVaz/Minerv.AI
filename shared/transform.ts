export interface LayerTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export const identityTransform: LayerTransform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
};
export const minLayerScale = 0.2;
export const maxLayerScale = 3;

export function validTransform(value: unknown): value is LayerTransform {
  if (!value || typeof value !== "object") return false;
  const { x, y, scale, rotation } = value as LayerTransform;
  return (
    [x, y, scale, rotation].every(Number.isFinite) &&
    Math.abs(x) <= 1 &&
    Math.abs(y) <= 1 &&
    scale >= minLayerScale &&
    scale <= maxLayerScale &&
    Math.abs(rotation) <= 180
  );
}
