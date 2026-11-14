import { defineConfig } from 'vite';
const BUILD = String(Date.now());
export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [{ name: 'version-file', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) }); } }],
});
