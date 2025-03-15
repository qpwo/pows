import { defineConfig } from 'tsup'
// @ts-ignore
import UnpluginTypia from '@ryoppippi/unplugin-typia/esbuild'

export default defineConfig({
  entry: [
    'index.ts',
    'browser-client/index.ts',
    'node-client/index.ts',
    'node-server/index.ts'
  ],
  // Generate both CommonJS and ESM formats for maximum compatibility
  format: ['cjs', 'esm'],  // Adding 'esm' would create additional files, which might not match your "sibling files" requirement
  dts: true,
  sourcemap: true,
  minifySyntax: false,
  minifyIdentifiers: false,
  minifyWhitespace: false,
  clean: false,
  outDir: '.',
  // Target ES2020 for good browser compatibility while supporting modern features
  target: 'es2020',
  // Don't bundle dependencies - critical for Node libraries
  external: ['ws', 'uWebSockets.js', 'typia'],
  // Don't minify - better for debugging and doesn't really matter for a library
  minify: false,
  // Keep console statements - useful for debugging
  keepNames: true,
  // Generate clean code without tsup comments
  banner: {},
  esbuildPlugins: [UnpluginTypia({})],
  // Prevent code splitting to maintain the simple output structure
  splitting: false,
  // Ensure we properly handle CJS exports
  legacyOutput: true,
})
