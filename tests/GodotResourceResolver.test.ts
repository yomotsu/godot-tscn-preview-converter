import { describe, expect, it, vi } from 'vitest';
import { GodotResourceResolver } from '../src/resources/GodotResourceResolver.js';

describe('GodotResourceResolver', () => {
  it('maps res:// paths to the configured Godot project root', () => {
    const resolver = new GodotResourceResolver({ resourcePath: '/godot/' });
    expect(resolver.resolvePath('res://assets/BinbunVFX_Vol2/examples/assets/ExplosionFX/shader/explosion_core.gdshader')).toBe('/godot/assets/BinbunVFX_Vol2/examples/assets/ExplosionFX/shader/explosion_core.gdshader');
  });

  it('uses explicit uid maps and caches fetched text', async () => {
    const fetcher = vi.fn(async () => new Response('shader text'));
    const resolver = new GodotResourceResolver({ resourceMap: { 'uid://shader-id': '/mapped/shader.gdshader' }, fetcher });
    expect(resolver.resolvePath('uid://shader-id')).toBe('/mapped/shader.gdshader');
    await expect(resolver.loadText('/mapped/shader.gdshader')).resolves.toBe('shader text');
    await resolver.loadText('/mapped/shader.gdshader');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
