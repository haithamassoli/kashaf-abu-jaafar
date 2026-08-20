export const SITE = 'كشّاف أبي جعفر'
export const SITE_URL = 'https://kashaf-alkulify.assoli.site'
export const SHEIKH = 'الشيخ أبو جعفر عبد الله بن فهد الخليفي'

/** The home page's <title>; every other page is `${title} — ${SITE}`. */
export const HOME_TITLE = `${SITE} — بحث في نصوص دروس الشيخ عبد الله الخليفي`

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

/** Where the contact form's mail lands. */
export const CONTACT_EMAIL = 'haitham.b.assoli@gmail.com'

/**
 * The contact form's `mailto:` — the subject is prefixed so replies are filterable, and
 * both parts are encoded: an unescaped `&` in the subject would otherwise swallow the body.
 * ponytail: long messages can exceed a mail handler's URL limit, hence the textarea's
 * maxlength; a real form endpoint is the fix if that ever bites.
 */
export const mailto = (subject: string, body: string) =>
  `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`[${SITE}] ${subject}`)}&body=${encodeURIComponent(body)}`
