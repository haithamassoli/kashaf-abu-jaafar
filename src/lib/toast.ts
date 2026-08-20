let timer: ReturnType<typeof setTimeout> | undefined

/** Site-wide toast. The element lives at body level in Base.astro. */
export function flash(message: string): void {
  const el = document.querySelector<HTMLElement>('#toast > span')
  if (!el) return
  el.textContent = message
  el.hidden = false
  clearTimeout(timer)
  timer = setTimeout(() => (el.hidden = true), 2000)
}
