import { describe, expect, it } from 'vitest';
import { getPreviewCameraClipRange, getPreviewFogScale } from '../src/app/camera-clip-range.js';

describe('preview camera depth range',()=>{
 it('keeps the full VFX in range when zoomed far out',()=>{
  const {near,far}=getPreviewCameraClipRange(800,15);
  expect(far).toBeGreaterThan(800+15);
  expect(near).toBeGreaterThan(0);
  expect(near).toBeLessThan(800);
  expect(far/near).toBeLessThan(2100);
 });
 it('uses a closer near plane for close orbit views',()=>{
  const close=getPreviewCameraClipRange(2,12), far=getPreviewCameraClipRange(100,12);
  expect(close.far).toBeGreaterThan(2);
  expect(close.near).toBeLessThan(far.near);
  expect(far.far).toBeGreaterThan(close.far);
    expect(getPreviewCameraClipRange(.08,12).far/getPreviewCameraClipRange(.08,12).near).toBeLessThanOrEqual(2000);
  });
  it('keeps far-view fog from hiding the VFX while preserving near-view fog',()=>{
    expect(getPreviewFogScale(20,.02,.01)).toBe(1);
    const scale=getPreviewFogScale(400,.02,.01);
    expect(scale).toBeLessThan(1);
    expect(400*(.02+.01)*scale).toBeCloseTo(.8);
 });
});
