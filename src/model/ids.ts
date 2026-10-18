export function uid(prefix = 'o'): string {
  let r = '';
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    r = a[0].toString(36) + a[1].toString(36);
  } catch {
    r = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  return `${prefix}_${Date.now().toString(36)}${r}`.slice(0, 32);
}
