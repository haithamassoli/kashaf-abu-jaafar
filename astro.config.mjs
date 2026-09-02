// @ts-check
import { defineConfig, fontProviders } from 'astro/config'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  site: 'https://alkulify.assoli.site',
  // Canonicals and the sitemap emit /path/ — keep dev and internal links on the same
  // form so Cloudflare Pages never has to 301 an internal hop.
  trailingSlash: 'always',
  compressHTML: true,
  experimental: { incrementalBuild: true },
  fonts: [
    {
      provider: fontProviders.local(),
      name: 'Thmanyah Sans',
      cssVariable: '--font-thmanyah-sans',
      fallbacks: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      options: {
        variants: [
          { src: ['./src/assets/fonts/thmanyahsans-Light.woff2'], weight: 300, style: 'normal' },
          { src: ['./src/assets/fonts/thmanyahsans-Regular.woff2'], weight: 400, style: 'normal' },
          { src: ['./src/assets/fonts/thmanyahsans-Medium.woff2'], weight: 500, style: 'normal' },
          { src: ['./src/assets/fonts/thmanyahsans-Bold.woff2'], weight: 700, style: 'normal' },
          { src: ['./src/assets/fonts/thmanyahsans-Black.woff2'], weight: 900, style: 'normal' },
        ],
      },
    },
  ],
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data: https://i.ytimg.com",
        "font-src 'self'",
        "connect-src 'self' https://search.assoli.site https://eu.i.posthog.com https://eu-assets.i.posthog.com",
        'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
        'upgrade-insecure-requests',
      ],
      scriptDirective: {
        resources: [
          { resource: "'self'", kind: 'element' },
          { resource: 'https://www.youtube.com', kind: 'element' },
          { resource: 'https://s.ytimg.com', kind: 'element' },
          { resource: "'none'", kind: 'attribute' },
        ],
      },
      styleDirective: {
        resources: [
          { resource: "'self'", kind: 'element' },
          { resource: "'none'", kind: 'attribute' },
        ],
      },
    },
  },
  integrations: [
    {
      name: 'theme-bootstrap',
      hooks: {
        'astro:config:setup': ({ injectScript }) =>
          injectScript(
            'head-inline',
            `try {
  const saved = localStorage.getItem('theme')
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', dark)
} catch {}`,
          ),
      },
    },
    {
      // أسماءُ العناصر المشتركة بين البطاقة وصفحة الدرس، يقرؤها الـ CSS.
      // head-inline لأنّ pagereveal يسبق تنفيذَ سكربتات <script> المؤجَّلة.
      name: 'nav-transitions',
      hooks: {
        'astro:config:setup': ({ injectScript }) =>
          injectScript(
            'head-inline',
            `const at = (url) => (url ? new URL(url, location.href).pathname : '')
const isItem = (path) => {
  // صفحاتُ المفردات وحدَها: /v/ درسٌ و/a/ مقالةٌ (والكتابُ منها) و/p/ قائمة.
  const seg = path.split('/')
  return seg.length === 4 && ['v', 'a', 'p'].includes(seg[1]) && !!seg[2]
}
const clearCard = () => {
  document.documentElement.classList.remove('vt-card')
  document
    .querySelectorAll('.vt-card-img, .vt-card-title')
    .forEach((el) => el.classList.remove('vt-card-img', 'vt-card-title'))
}

// يسمّي مصغّرةَ البطاقة الموافقة لهذا المسار وعنوانَها، إن وُجدت.
// البادئة لا المطابقة: الروابطُ تحمل ?q= و#p3 بعد المسار.
const nameCard = (path) => {
  clearCard()
  const card = isItem(path) && document.querySelector('a[href^="' + path + '"]')
  if (!card) return
  card.querySelector('img')?.classList.add('vt-card-img')
  const title = card.querySelector('[data-vt-title]')
  if (!title) return
  title.classList.add('vt-card-title')
  // العنوانُ الكبيرُ في الصفحة نفسها يحمل الاسمَ ذاته — يتنحّى كي لا يتكرّر.
  document.documentElement.classList.add('vt-card')
}

addEventListener('pageswap', (e) => {
  if (e.viewTransition) nameCard(at(e.activation?.entry.url))
})

// الرجوعُ إلى القائمة: البطاقةُ التي جئنا منها هي طرفُ التحوُّل هنا.
addEventListener('pagereveal', (e) => {
  const vt = e.viewTransition
  if (!vt) return
  nameCard(at(globalThis.navigation?.activation?.from?.url))
  vt.finished.finally(clearCard)
})`,
          ),
      },
    },
    react(),
    sitemap({
      // Error pages and /saved/ are noindex; the latter is empty until localStorage fills it.
      filter: (page) => !['/404/', '/422/', '/500/', '/saved/'].some((path) => page.endsWith(path)),
      serialize: (item) => ({
        ...item,
        // Lesson pages are the long tail; the hubs are what we want crawled first.
        priority: item.url.includes('/v/') ? 0.6 : 0.8,
      }),
    }),
  ],
  // The site has no Markdown routes, and Shiki's inline styles conflict with CSP.
  markdown: { syntaxHighlight: false },
  vite: { plugins: [tailwindcss()] },
  build: { inlineStylesheets: 'auto' },
})
