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
      // Proxy Google Satellite tile requests to avoid CORS on localhost
      '/google-tiles': {
        target: 'https://mt1.google.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/google-tiles/, ''),
        secure: true,
      },
      // Proxy AWS Terrain Tiles (Terrarium elevation) to avoid CORS on localhost
      '/terrain-tiles': {
        target: 'https://s3.amazonaws.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/terrain-tiles/, ''),
        secure: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800, // Three.js bundle is large — suppress warning
  },
});
