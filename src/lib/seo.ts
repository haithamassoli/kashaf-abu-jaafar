export const SITE = 'كشّاف أبي جعفر'
export const SITE_URL = 'https://kashaf-alkulify.assoli.site'
export const SHEIKH = 'الشيخ أبو جعفر عبد الله بن فهد الخليفي'

/** The lessons' author — referenced by @id from every VideoObject. */
export const person = {
  '@type': 'Person',
  '@id': `${SITE_URL}/#person`,
  name: 'عبد الله بن فهد الخليفي',
  alternateName: 'أبو جعفر الخليفي',
  sameAs: [
    'https://www.youtube.com/@Alkulify1',
    'https://x.com/Xalkulify',
    'https://www.facebook.com/alkulify',
    'https://t.me/alkulife',
  ],
}

/** `trail` is [name, path] pairs; the site root is prepended automatically. */
export const breadcrumb = (trail: [string, string][]) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [['الرئيسية', '/'], ...trail].map(([name, path], i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name,
    item: new URL(path, SITE_URL).href,
  })),
})
