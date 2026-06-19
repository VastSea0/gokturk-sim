import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy ESRI satellite tile requests to avoid CORS on localhost
      '/esri-tiles': {
        target: 'https://server.arcgisonline.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/esri-tiles/, ''),
        secure: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800, // Three.js bundle is large — suppress warning
  },
});
