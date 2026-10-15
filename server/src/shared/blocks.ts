export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'dialogue'; text: string }
  | { kind: 'image'; assetName: string; width?: number; height?: number; slotId?: string; revisionId?: string }
  | { kind: 'divider' };

/** 위치(앵커)·글자 수 계산에 쓰는 블록의 텍스트 표현. 이미지는 에셋 이름을 쓴다. */
export function blockText(b: Block): string {
  switch (b.kind) {
    case 'paragraph':
    case 'dialogue':
      return b.text;
    case 'image':
      return `image:${b.assetName}`;
    case 'divider':
      return '';
  }
}
