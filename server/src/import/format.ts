// RisuAI 채팅 내보내기 JSON (임포트 스펙 §2, Q11: RisuAI 1.14.0 importChat). 형식만 보고, 내용은 그대로 보존한다.
export const IMPORT_LIMITS = { fileBytes: 50 * 1024 * 1024, chatsPerFile: 500, imageBytes: 10 * 1024 * 1024, nameMax: 60 } as const;

export type ParsedChat = { id: string | null; title: string; lastDate: number | null; messages: unknown[]; raw: Record<string, unknown> };
export type ParseResult = { ok: true; chats: ParsedChat[] } | { ok: false; error: 'unsupported-format' | 'too-many-chats' };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseRisuExport(json: unknown): ParseResult {
  if (!isObj(json) || (json.type !== 'risuChat' && json.type !== 'risuAllChats') || json.ver !== 2 || json.data === undefined) return { ok: false, error: 'unsupported-format' };
  const list = Array.isArray(json.data) ? json.data : [json.data];
  if (!list.every(isObj)) return { ok: false, error: 'unsupported-format' };
  if (list.length > IMPORT_LIMITS.chatsPerFile) return { ok: false, error: 'too-many-chats' };
  return {
    ok: true,
    chats: list.map((c) => {
      const messages = Array.isArray(c.message) ? c.message : [];
      return {
        id: typeof c.id === 'string' ? c.id : null,
        title: typeof c.name === 'string' ? c.name : '',
        lastDate: typeof c.lastDate === 'number' ? c.lastDate : null,
        messages,
        raw: { ...c, message: messages },
      };
    }),
  };
}
