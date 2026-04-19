import { defineConfig } from 'vite';

export default defineConfig({
  // Base path for GitHub Pages deployment.
  // Change to '/' if deploying to a custom domain or the root of a Pages site.
  base: '/beach-walk-uk/',

  build: {
    // Output directory — contents of dist/ are deployed to GitHub Pages
    outDir: 'dist',
    // Inline assets smaller than 4kb as base64 data URIs
    assetsInlineLimit: 4096,
  },
});
