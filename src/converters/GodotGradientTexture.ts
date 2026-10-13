export interface GodotGradientTextureRecipe {
  width: number;
  height: number;
  fill: 'linear' | 'radial';
  from: number[];
  to: number[];
  hdr: boolean;
  offsets: number[];
  colors: number[];
  interpolationMode: number;
}

/** Self-contained so the class runtime can embed the same pixel generator. */
export function generateGodotGradientTextureData(recipe: GodotGradientTextureRecipe): Uint8Array | Float32Array {
  const { width, height, from, to, hdr, offsets, colors } = recipe;
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const denominator = dx * dx + dy * dy || 1;
  const data = hdr ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rx = (width > 1 ? x / (width - 1) : 0) - from[0];
    const ry = (height > 1 ? 1 - y / (height - 1) : 0) - from[1];
    const t = Math.max(0, Math.min(1, recipe.fill === 'radial'
      ? Math.hypot(rx, ry) / Math.sqrt(denominator) : (rx * dx + ry * dy) / denominator));
    let left = offsets.length - 1, right = left, blend = 0;
    if (t <= offsets[0]) left = right = 0;
    else for (let i = 1; i < offsets.length; i++) if (t <= offsets[i]) {
      left = i - 1; right = i;
      blend = recipe.interpolationMode === 1 ? 0 : (t - offsets[left]) / (offsets[right] - offsets[left]);
      break;
    }
    for (let channel = 0; channel < 4; channel++) {
      const a = colors[left * 4 + channel], b = colors[right * 4 + channel];
      const value = a + (b - a) * blend;
      data[(y * width + x) * 4 + channel] = hdr ? value : Math.round(Math.max(0, Math.min(1, value)) * 255);
    }
  }
  return data;
}
