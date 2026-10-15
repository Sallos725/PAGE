// 본문의 에셋 이름 참조 (findings §3.2): CBS 이름 마커 `{{raw::NAME}}` 등과 Asset Maid 의 data-am-asset 속성.
// 인레이(`{{inlay::id}}`)는 저장 위치가 달라 이 단계에서 다루지 않는다 (이 인스턴스엔 0건).
const NAME_MARKER = /\{\{(?:raw|path|img|image|video|audio|bg|asset)::([^}\n]{1,300}?)\}\}/g;
const NAME_ATTR = /data-am-asset="([^"]{1,300})"/g;

/** Asset Maid 규칙 이름: <기본이름>.__am__.(chat|outfit).<uuid> (storage-notes 7.3) */
const AM_NAME = /\.__am__\.(?:chat|outfit)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function isTrackedAssetName(name: string): boolean {
  return AM_NAME.test(name);
}

export function extractAssetNames(messages: unknown[]): string[] {
  const out = new Set<string>();
  for (const m of messages) {
    const text = (m as { data?: unknown } | null)?.data;
    if (typeof text !== 'string') continue;
    for (const re of [NAME_MARKER, NAME_ATTR]) {
      for (const x of text.matchAll(re)) out.add((x[1] ?? '').trim());
    }
  }
  out.delete('');
  return [...out];
}
