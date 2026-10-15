// Host 허용 목록 (스펙 §5.1, DNS rebinding 막기). 항목에 포트가 없으면 어느 포트든 같은 이름이면 허용.
const split = (s: string) => {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s.trim().toLowerCase());
  return m ? { name: m[1]!, port: m[2] ?? null } : null;
};

export function hostAllowed(host: string | undefined, allowed: string[]): boolean {
  if (!host) return false;
  const h = split(host);
  if (!h) return false;
  return allowed.some((a) => {
    const e = split(a);
    return !!e && e.name === h.name && (e.port === null || e.port === h.port);
  });
}
