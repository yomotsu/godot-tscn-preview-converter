import { realpath, stat, readFile, cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { minifyVfxRuntime } from './scripts/minify-vfx-runtime.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const appRoot = path.join(projectRoot, 'src/app');
const require = createRequire(import.meta.url);
const threeRoot = path.resolve(path.dirname(require.resolve('three')), '..');
const mimeTypes = {
  '.js': 'text/javascript; charset=utf-8',
  '.tscn': 'text/plain; charset=utf-8', '.tres': 'text/plain; charset=utf-8',
  '.gdshader': 'text/plain; charset=utf-8', '.gdshaderinc': 'text/plain; charset=utf-8', '.gd': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.gif': 'image/gif', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
};

async function resolveFile(root, relativePath) {
  if (relativePath.split(/[\\/]/).some((part) => part === '..' || part.startsWith('.'))) return undefined;
  try {
    const base = await realpath(root);
    const candidate = path.resolve(base, relativePath);
    if (candidate !== base && !candidate.startsWith(base + path.sep)) return undefined;
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(base + path.sep) || !(await stat(resolved)).isFile()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function sendFile(req, res, next, file) {
  if (!file) return next();
  const contentType = mimeTypes[path.extname(file).toLowerCase()];
  if (!contentType) return next();
  return readFile(file).then((contents) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', contents.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(req.method === 'HEAD' ? undefined : contents);
  }).catch(() => next());
}

function requestPath(req) {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    return undefined;
  }
}

function externalGodotRootPlugin() {
  return {
    name: 'preview-assets',
    async configureServer(server) {
      const runtime = await minifyVfxRuntime();
      const godotRoot = process.env.GODOT_ROOT ? path.resolve(process.env.GODOT_ROOT) : undefined;
      server.middlewares.use(async (req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) return next();
        const pathname = requestPath(req);
        if (!pathname) return next();
        let file;
        if (pathname.startsWith('/vendor/three/')) {
          file = await resolveFile(threeRoot, pathname.slice('/vendor/three/'.length));
        } else if (pathname === '/three-class/AbstractVFXMesh.min.js') {
          res.statusCode = 200;
          res.setHeader('Content-Type', mimeTypes['.js']);
          res.setHeader('Content-Length', runtime.length);
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          return res.end(req.method === 'HEAD' ? undefined : runtime);
        } else if (pathname.startsWith('/examples/assets/')) {
          file = await resolveFile(path.join(projectRoot, 'examples/assets'), pathname.slice('/examples/assets/'.length));
        } else if (pathname.startsWith('/godot/')) {
          const relative = pathname.slice('/godot/'.length);
          if (godotRoot) file = await resolveFile(godotRoot, relative);
        }
        return sendFile(req, res, next, file);
      });
    },
    configurePreviewServer(server) {
      const godotRoot = process.env.GODOT_ROOT ? path.resolve(process.env.GODOT_ROOT) : undefined;
      if (!godotRoot) return;
      server.middlewares.use(async (req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) return next();
        const pathname = requestPath(req);
        if (!pathname) return next();
        if (!pathname.startsWith('/godot/')) return next();
        const file = await resolveFile(godotRoot, pathname.slice('/godot/'.length));
        return sendFile(req, res, next, file);
      });
    },
  };
}

function publicBuildPlugin() {
  let output;
  return {
    name: 'public-build',
    apply: 'build',
    configResolved(config) {
      output = path.resolve(config.root, config.build.outDir);
    },
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'three-class/AbstractVFXMesh.min.js',
        source: await minifyVfxRuntime(),
      });
    },
    async writeBundle() {
      await mkdir(path.join(output, 'examples'), { recursive: true });
      await cp(path.join(projectRoot, 'examples/assets'), path.join(output, 'examples/assets'), {
        recursive: true, filter: (source) => path.basename(source) !== '.DS_Store',
      });
      await cp(path.join(threeRoot, 'build'), path.join(output, 'vendor/three/build'), { recursive: true });
      await cp(path.join(threeRoot, 'examples/jsm'), path.join(output, 'vendor/three/examples/jsm'), { recursive: true });
      await cp(path.join(threeRoot, 'LICENSE'), path.join(output, 'vendor/three/LICENSE'));
      await cp(path.join(projectRoot, 'src/app/vendor/terser.bundle.min.js'), path.join(output, 'vendor/terser.bundle.min.js'));
      await cp(path.join(projectRoot, 'src/app/vendor/TERSER-LICENSE.txt'), path.join(output, 'vendor/TERSER-LICENSE.txt'));
      await cp(path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'));
    },
  };
}

export default defineConfig({
  plugins: [externalGodotRootPlugin(), publicBuildPlugin()],
  root: appRoot,
  appType: 'mpa',
  base: '/',
  publicDir: false,
  server: { fs: { allow: [projectRoot] } },
  build: {
    outDir: path.join(projectRoot, 'dist'),
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'es2022',
    rollupOptions: {
      input: [
        path.join(appRoot, 'index.html'),
        path.join(appRoot, 'three-class/index.html'),
      ],
      // Keep one Three.js module instance shared with downloaded classes.
      external: (id) => id === 'three' || id === 'three/webgpu' || id === 'three/tsl',
    },
  },
});
