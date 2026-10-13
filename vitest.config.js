import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default mergeConfig(viteConfig, defineConfig({
  root: projectRoot,
}));
