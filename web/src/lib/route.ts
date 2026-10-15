export type Route =
  | { name: 'home' }
  | { name: 'chars'; source: string }
  | { name: 'chats'; source: string; char: string }
  | { name: 'read'; source: string; char: string; chat: string }
  | { name: 'appearance' }
  | { name: 'highlights' }
  | { name: 'notfound' };

const dec = (s: string): string | null => {
  try { return decodeURIComponent(s); } catch { return null; }
};

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((p) => p !== '');
  const d = parts.map(dec);
  if (d.some((x) => x === null)) return { name: 'notfound' };
  const p = d as string[];
  if (p.length === 0) return { name: 'home' };
  if (p[0] === 's' && p.length === 2) return { name: 'chars', source: p[1]! };
  if (p[0] === 's' && p[2] === 'c' && p.length === 4) return { name: 'chats', source: p[1]!, char: p[3]! };
  if (p[0] === 'appearance' && p.length === 1) return { name: 'appearance' };
  if (p[0] === 'highlights' && p.length === 1) return { name: 'highlights' };
  if (p[0] === 'read' && p.length === 4) return { name: 'read', source: p[1]!, char: p[2]!, chat: p[3]! };
  return { name: 'notfound' };
}

const e = encodeURIComponent;
export const hrefs = {
  home: '#/',
  appearance: '#/appearance',
  highlights: '#/highlights',
  chars: (s: string) => `#/s/${e(s)}`,
  chats: (s: string, c: string) => `#/s/${e(s)}/c/${e(c)}`,
  read: (s: string, c: string, h: string) => `#/read/${e(s)}/${e(c)}/${e(h)}`,
};
