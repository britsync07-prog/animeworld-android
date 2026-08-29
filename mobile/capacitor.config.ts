import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.animeworld.app',
  appName: 'AnimeWorld',
  // The PWA lives one level up, in ../web. Capacitor copies it into the native shell.
  webDir: '../web',
  server: {
    // https scheme avoids cleartext/file restrictions on Android and keeps
    // Service Worker + Cache Storage working inside the WebView.
    androidScheme: 'https'
  }
};

export default config;
