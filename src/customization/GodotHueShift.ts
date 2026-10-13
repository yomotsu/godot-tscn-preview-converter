import { Color } from 'three';

/** Use the same HDR-preserving hue rotation for lights and shader colors. */
export function rotateGodotHue(source: Color, turns: number, target: Color): void {
  const r = Math.max(0, source.r), g = Math.max(0, source.g), b = Math.max(0, source.b);
  const high = Math.max(r, g, b), low = Math.min(r, g, b), chroma = high - low;
  if (Math.abs(turns) < 0.000001 || chroma < 0.000001) { target.copy(source); return; }
  const hue = (high === r ? (g - b) / chroma : high === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4) / 6 + turns;
  const channel = (offset: number) => {
    const value = hue + offset;
    const wheel = Math.abs((value - Math.floor(value)) * 6 - 3);
    return low + chroma * Math.max(0, Math.min(1, wheel - 1));
  };
  target.setRGB(channel(0), channel(2 / 3), channel(1 / 3));
}
