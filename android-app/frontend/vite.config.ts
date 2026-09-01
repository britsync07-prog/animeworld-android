import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'autoUpdate',
      includeAssets: ['hls.min.js', 'icon.svg'],
      manifest: {
        name: 'AnimeWorld',
        short_name: 'AnimeWorld',
        description: 'Anime streaming app',
        theme_color: '#0e1118',
        background_color: '#0e1118',
        display: 'standalone',
        icons: [
          { src: '/icon.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,m3u8,ts}'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /^\/api\/v1\/(hls|hls\.m3u8)(\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'animeworld-hls-offline',
              networkTimeoutSeconds: 15,
              expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
});
