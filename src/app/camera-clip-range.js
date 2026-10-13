/** Keep orbit previews inside a useful depth range as the camera zooms. */
export function getPreviewCameraClipRange(distance, sceneExtent) {
  const safeDistance = Math.max(0.01, Number.isFinite(distance) ? distance : 0.01);
  const safeExtent = Math.max(0, Number.isFinite(sceneExtent) ? sceneExtent : 0);
  const far = Math.max(20, safeDistance + Math.max(1, safeExtent * 1.25));
  const near = Math.min(safeDistance * 0.95, Math.max(0.01, safeDistance * 0.02, far / 2000));
  return { near, far };
}

/** Reduce preview fog only when zooming out would otherwise hide the loaded effect. */
export function getPreviewFogScale(distance, fogDensity, volumetricDensity, maxOpticalDepth = 0.8) {
  const safeDistance = Math.max(0, Number.isFinite(distance) ? distance : 0);
  const safeFogDensity = Math.max(0, Number.isFinite(fogDensity) ? fogDensity : 0);
  const safeVolumetricDensity = Math.max(0, Number.isFinite(volumetricDensity) ? volumetricDensity : 0);
  const safeMaxOpticalDepth = Math.max(0.01, Number.isFinite(maxOpticalDepth) ? maxOpticalDepth : 1);
  const opticalDepth = safeDistance * (safeFogDensity + safeVolumetricDensity);
  return opticalDepth > safeMaxOpticalDepth ? safeMaxOpticalDepth / opticalDepth : 1;
}
