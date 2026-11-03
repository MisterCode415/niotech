import process from 'node:process';
import { defineConfig } from 'astro/config';

// Fully static output: the build is a folder of HTML/CSS that any static host can serve.
export default defineConfig({
  output: 'static',
  site: process.env.PUBLIC_SITE_URL || 'https://qinio.co',
  devToolbar: { enabled: false },
});
