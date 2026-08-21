// @ts-check
import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  site: 'https://alkulify.assoli.site',
  // Canonicals and the sitemap emit /path/ — keep dev and internal links on the same
  // form so Cloudflare Pages never has to 301 an internal hop.
  trailingSlash: 'always',
  integrations: [
    react(),
    sitemap({
      // /404 and /saved/ are the only pages that shouldn't be listed — /saved/ is an
      // empty shell until localStorage fills it in. Everything else is indexable.
      filter: (page) => !page.endsWith('/404/') && !page.endsWith('/saved/'),
      serialize: (item) => ({
        ...item,
        // Lesson pages are the long tail; the hubs are what we want crawled first.
        priority: item.url.includes('/v/') ? 0.6 : 0.8,
      }),
    }),
  ],
  vite: { plugins: [tailwindcss()] },
  build: { inlineStylesheets: 'auto' },
})
