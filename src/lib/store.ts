/**
 * Bookmarks and notes, keyed by page path, in one localStorage entry.
 * ponytail: no sync, no export, no per-item keys — one JSON blob is a few hundred
 * bytes for a heavy reader. Split it only if someone saves thousands of pages.
 */
const KEY = 'kashaf:saved'

export type Kind = 'v' | 'a' | 'p'
export type Item = { title: string; kind: Kind; at: number; mark?: true; note?: string }

export function all(): Record<string, Item> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function save(items: Record<string, Item>): void {
  // Private-mode Safari throws on setItem; a lost bookmark must not break the page.
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {}
}

/**
 * Merge `fields` into the entry for `path` and return what is now stored.
 * An entry left with neither a bookmark nor a note is dropped, so unstarring a
 * page the reader never annotated leaves nothing behind.
 */
export function update(
  path: string,
  meta: { title: string; kind: Kind },
  fields: Partial<Item>,
): Item | undefined {
  const items = all()
  const next: Item = { ...items[path], ...meta, ...fields, at: Date.now() }
  if (next.mark || next.note) items[path] = next
  else delete items[path]
  save(items)
  return items[path]
}
