export type SourceKind = 'pocketrisu-sqlite';

export type PageMessage = { idx: number; role: 'user' | 'char'; text: string; time?: number };

export type SourceStatus = 'ok' | 'degraded' | 'unavailable';
export type SourceHealth = { id: string; kind: SourceKind; status: SourceStatus; reasons: string[] };

export type RawChat = {
  chatId: string;
  title: string;
  lastDate: number | null;
  meta: Record<string, unknown>; // 채팅 객체에서 message 를 뺀 raw 필드 (내보내기용, 스펙 3.5.2)
  messages: unknown[]; // 원본 포맷. 어댑터 밖으로는 normalizeMessage 로만 나간다.
};
export type ChatRead = { ok: true; chat: RawChat } | { ok: false; chatId: string; reason: string };

/** Syncer 가 캐릭터 하나를 처리하는 동안만 유효하다 (콜백이 끝나면 디코드 객체가 해제된다). */
export interface CharacterHandle {
  readonly charId: string;
  readonly name: string;
  readonly meta: Record<string, unknown>;
  /** 대표 이미지의 kv 키 (`assets/…`, 검증됨). 없으면 null. (D27) */
  readonly imageRef: string | null;
  /** 대표 이미지 바이트. 없거나 읽을 수 없으면 null. */
  readImage(): Uint8Array | null;
  readonly chats: ChatRead[];
  /** 메시지 본문이 참조하는 에셋 이름들 */
  assetNames(messages: unknown[]): string[];
  /** 해석에 실패해도 기록할 가치가 있는 이름인가 (예: Asset Maid 규칙 이름) */
  isTrackedAssetName(name: string): boolean;
  /** 읽기 전용으로 바이트를 꺼낸다. 없으면 null. */
  readAsset(name: string): Uint8Array | null;
}

export type ScanOptions = { only?: { charId: string; chatId: string } };
export type ScanResult = {
  /** 소스를 정상적으로 끝까지 읽었는가. false 면 어떤 삭제 판단도 하면 안 된다 (R6). */
  complete: boolean;
  /** 이번에 *존재가 확인된* 캐릭터→채팅 id 들 (unreadable 채팅 포함) */
  seen: Map<string, Set<string>>;
  unreadable: number;
  error?: string;
};

export interface SourceAdapter {
  readonly id: string;
  readonly kind: SourceKind;
  health(): Promise<SourceHealth>;
  /** 소스 전체 지문. null = 읽기 실패(변경이 아니다). */
  fingerprint(): Promise<string | null>;
  scan(onCharacter: (c: CharacterHandle) => Promise<void> | void, options?: ScanOptions): Promise<ScanResult>;
}
