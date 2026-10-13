import {
  BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, CylinderGeometry, PlaneGeometry, SphereGeometry, TorusGeometry,
} from 'three';
import type { GodotResourceSection, GodotValue } from '../tscn/types.js';
import { isGodotCall } from '../tscn/types.js';

/** Builds three.js geometry for common Godot primitive and serialized ArrayMesh resources. */
export class GodotMeshConverter {
  convert(resource: GodotResourceSection, warn: (message: string) => void): BufferGeometry | undefined {
    const p = resource.properties;
    switch (resource.resourceType) {
      case 'ArrayMesh':
        return this.convertArrayMesh(resource, warn);
      case 'BoxMesh': {
        const size = vector3(p.size, [1, 1, 1]);
        return new BoxGeometry(size[0], size[1], size[2]);
      }
      case 'SphereMesh': {
        const radius = number(p.radius, 0.5);
        const geometry = new SphereGeometry(radius, number(p.radial_segments, 64), number(p.rings, 32) + 1);
        // Godot SphereMesh defaults to a fixed height of 1.0, independent of
        // radius. Using the diameter here makes omitted-height meshes (often
        // the inner Core mesh in VFX scenes) too short and visibly separates
        // them from the surrounding head/trail.
        const height = number(p.height, 1.0);
        const hemisphere = Boolean(p.is_hemisphere);
        const scaleY = radius > 0 ? height / (radius * (hemisphere ? 1 : 2)) : 1;
        if (radius > 0 && hemisphere) {
          const positions = geometry.getAttribute('position');
          const normals = geometry.getAttribute('normal');
          for (let i = 0; i < positions.count; i++) {
            const normalizedY = positions.getY(i) / radius;
            if (normalizedY < 0) {
              // Godot flattens the lower half onto the equator to form the cap.
              positions.setY(i, 0);
              normals.setXYZ(i, 0, -1, 0);
            } else {
              positions.setY(i, normalizedY * height);
              const nx = normals.getX(i) * scaleY;
              const ny = normals.getY(i);
              const nz = normals.getZ(i) * scaleY;
              const normalLength = Math.hypot(nx, ny, nz) || 1;
              normals.setXYZ(i, nx / normalLength, ny / normalLength, nz / normalLength);
            }
          }
          positions.needsUpdate = true;
          normals.needsUpdate = true;
        } else if (radius > 0 && Math.abs(scaleY - 1) > 1e-6) {
          geometry.scale(1, scaleY, 1);
        }
        geometry.rotateY(Math.PI/2);
        const uv=geometry.getAttribute('uv');
        for(let i=0;i<uv.count;i++) uv.setY(i,1-uv.getY(i));
        geometry.userData.godotGeometryRecipe = { kind: 'sphere', scaleY, hemisphere };
        return geometry;
      }
      case 'PlaneMesh' : {
        const size = vector2(p.size, [2, 2]);
        const geometry = new PlaneGeometry(size[0], size[1], number(p.subdivide_width, 0) + 1, number(p.subdivide_depth, 0) + 1);
        geometry.rotateX(-Math.PI / 2); // Godot PlaneMesh lies on XZ, facing +Y.
        geometry.userData.godotGeometryRecipe = { kind: 'plane' };
        return geometry;
      }
      case 'QuadMesh': {
        const size = vector2(p.size, [1, 1]);
        return new PlaneGeometry(size[0], size[1]);
      }
      case 'CylinderMesh': {
        const geometry = new CylinderGeometry(
          number(p.top_radius, 0.5), number(p.bottom_radius, 0.5), number(p.height, 2),
          number(p.radial_segments, 64), number(p.rings, 4) + 1, !Boolean(p.cap_top ?? true) && !Boolean(p.cap_bottom ?? true),
        );
        applyCylinderUV(geometry);
        geometry.userData.godotGeometryRecipe = { kind: 'cylinderUV' };
        return geometry;
      }
      case 'CapsuleMesh': {
        const radius = number(p.radius, 0.5);
        const height = number(p.height, 2);
        return new CapsuleGeometry(radius, Math.max(0, height - radius * 2), number(p.rings, 8), number(p.radial_segments, 16));
      }
      case 'TorusMesh': {
        const inner = number(p.inner_radius, 0.5), outer = number(p.outer_radius, 1);
        const geometry = new TorusGeometry((inner + outer) / 2, Math.max(0, (outer - inner) / 2), number(p.ring_segments, 32), number(p.rings, 64));
        geometry.rotateX(-Math.PI / 2);
        geometry.userData.godotGeometryRecipe = { kind: 'torus' };
        return geometry;
      }
      case 'TubeTrailMesh': {

        const radius = number(p.radius, 0.1);
        const sections = number(p.sections, 5), rings = number(p.section_rings, 3);
        const geometry = new CylinderGeometry(radius,radius,number(p.section_length,0.2)*sections,number(p.radial_steps,8),sections*rings,true);
        applyCylinderUV(geometry);
        geometry.userData.godotTrailRadius = radius;
        geometry.userData.godotTrailCurve = p.curve;
        geometry.userData.godotGeometryRecipe = { kind: 'cylinderUV' };
        return geometry;
      }
      default:
        return undefined;
    }
  }

  private convertArrayMesh(resource: GodotResourceSection, warn: (message: string) => void): BufferGeometry | undefined {
    const surfaces = resource.properties._surfaces;
    if (!Array.isArray(surfaces) || surfaces.length === 0) return undefined;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    for (let surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex++) {
      const surface = surfaces[surfaceIndex];
      if (!isRecord(surface)) return undefined;
      const vertexCount = number(surface.vertex_count, 0);
      const indexCount = number(surface.index_count, 0);
      const primitive = number(surface.primitive, 3);
      const vertexBytes = packedBytes(surface.vertex_data);
      const attributeBytes = packedBytes(surface.attribute_data);
      const indexBytes = packedBytes(surface.index_data);

      // Godot packs each vertex attribute contiguously inside vertex_data:
      // position is the first 12 bytes per vertex, followed by packed normals
      // and tangents. UV1 is stored in the 8-byte attribute_data sidecar.
      // This covers the compressed vertex format used by the supplied slash
      // meshes while keeping unsupported packed layouts on the normal warning path.
      if (primitive !== 3 || vertexCount <= 0 || !vertexBytes || !attributeBytes ||
          vertexBytes.byteLength !== vertexCount * 20 || attributeBytes.byteLength !== vertexCount * 8 ||
          (indexCount > 0 && (!indexBytes || indexBytes.byteLength !== indexCount * 2))) {
        warn(`ArrayMesh '${resource.id}' has an unsupported packed surface layout`);
        return undefined;
      }

      const vertexView = new DataView(vertexBytes.buffer, vertexBytes.byteOffset, vertexBytes.byteLength);
      const attributeView = new DataView(attributeBytes.buffer, attributeBytes.byteOffset, attributeBytes.byteLength);
      const vertexOffset = positions.length / 3;
      for (let i = 0; i < vertexCount; i++) {
        const vertexOffsetBytes = i * 12;
        positions.push(
          vertexView.getFloat32(vertexOffsetBytes, true),
          vertexView.getFloat32(vertexOffsetBytes + 4, true),
          vertexView.getFloat32(vertexOffsetBytes + 8, true),
        );
        const uvOffsetBytes = i * 8;
        uvs.push(attributeView.getFloat32(uvOffsetBytes, true), attributeView.getFloat32(uvOffsetBytes + 4, true));
      }

      const groupStart = indices.length;
      if (indexCount > 0 && indexBytes) {
        const indexView = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);
        for (let i = 0; i < indexCount; i++) indices.push(vertexOffset + indexView.getUint16(i * 2, true));
      } else {
        for (let i = 0; i < vertexCount; i++) indices.push(vertexOffset + i);
      }
      groups.push({ start: groupStart, count: indices.length - groupStart, materialIndex: surfaceIndex });
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(indices);
    for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function number(value: GodotValue | undefined, fallback: number): number { return typeof value === 'number' ? value : fallback; }
function vector2(value: GodotValue | undefined, fallback: [number, number]): [number, number] {
  return isGodotCall(value) && value.name === 'Vector2' ? [Number(value.args[0]), Number(value.args[1])] : Array.isArray(value) ? [Number(value[0]), Number(value[1])] : fallback;
}
function vector3(value: GodotValue | undefined, fallback: [number, number, number]): [number, number, number] {
  return isGodotCall(value) && value.name === 'Vector3' ? [Number(value.args[0]), Number(value.args[1]), Number(value.args[2])] : Array.isArray(value) ? [Number(value[0]), Number(value[1]), Number(value[2])] : fallback;
}

function isRecord(value: GodotValue | undefined): value is Record<string, GodotValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isGodotCall(value);
}

function packedBytes(value: GodotValue | undefined): Uint8Array | undefined {
  if (!isGodotCall(value) || value.name !== 'PackedByteArray' || typeof value.args[0] !== 'string') return undefined;
  const binary = atob(value.args[0]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Godot reserves UV.y 0..0.5 for the wall and 0.5..1 for the two caps. */
function applyCylinderUV(geometry: BufferGeometry): void {
  const uv=geometry.getAttribute('uv'), index=geometry.getIndex();
  if(!index) return;
  for(const group of geometry.groups) {
    const vertices=new Set<number>();
    for(let i=group.start;i<group.start+group.count;i++) vertices.add(index.getX(i));
    for(const i of vertices) {
      if(group.materialIndex===0) uv.setY(i,(1-uv.getY(i))*0.5);
      else uv.setXY(i,uv.getX(i)*0.5+(group.materialIndex===2 ? 0.5 : 0),uv.getY(i)*0.5+0.5);
    }
  }
}
