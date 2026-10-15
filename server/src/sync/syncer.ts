import { canon, sha256Hex } from '../canon.js';
import { classifyChat } from '../library/classify.js';
import { decideVersion } from '../library/decide.js';
import { planDeletions } from '../library/deletions.js';
import type { AssetRefRow, LibraryStore } from '../library/store.js';
import { assetMime } from '../source/pocketrisu/assets.js';
import type { CharacterHandle, RawChat, SourceAdapter } from '../source/types.js';
import { ruleNamesInWorker, type RuleInput } from './image-rule-names.js';

export type SyncPolicy = {
  debounceMs: number; // D17 잠정값
  massDeletionRatio: number; // R6
  warnFreePct: number; // D15 (스펙 3.4.6)
  warnFreeBytes: number;
  stopAssetsFreeBytes: number;
  freeSpace: () => { freeBytes: number; totalBytes: number };
};

export type SyncOptions = {
  /** 채팅 열 때 동기화 등: 디바운스 무시, 소스 지문 단축 무시 */
  force?: boolean;
  /** R6 보류를 무시하고 삭제 표시를 적용 */
  acceptMassDeletion?: boolean;
  /** 이 채팅 하나만 (삭제 판단·지문 확정은 하지 않는다) */
  only?: { charId: string; chatId: string };
  /** 이 캐릭터만 (채팅 전부). `only` 와 같이 삭제 판단·지문 확정은 하지 않는다 — 전체 동기화일 때만 한다. */
  onlyChar?: string;
};

export type SyncReport = {
  source: string;
  startedAt: number;
  finishedAt: number;
  outcome: 'synced' | 'unchanged' | 'skipped';
  reason?: string;
  chars: { seen: number; tombstoned: number };
  chats: { created: number; appended: number; edited: number; unchanged: number; pending: number; tombstoned: number; unreadable: number };
  assets: { copied: number; deduped: number; deferred: number; unresolved: number; filled: number };
  held?: { items: number; missing: number };
  errors: number;
};

const newReport = (source: string, now: number): SyncReport => ({
  source, startedAt: now, finishedAt: now, outcome: 'synced',
  chars: { seen: 0, tombstoned: 0 },
  chats: { created: 0, appended: 0, edited: 0, unchanged: 0, pending: 0, tombstoned: 0, unreadable: 0 },
  assets: { copied: 0, deduped: 0, deferred: 0, unresolved: 0, filled: 0 },
  errors: 0,
});

export class Syncer {
  imageRuleBudgetMs = 2000; // 캐릭터당 카드 그림 규칙 시간 제한 (스펙 3C C5)
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: { store: LibraryStore; now: () => number; policy: SyncPolicy }) {}

  /** 소스 단위 직렬 실행 (스펙 3.4.4). */
  syncSource(adapter: SourceAdapter, opts: SyncOptions = {}): Promise<SyncReport> {
    const prev = this.chains.get(adapter.id) ?? Promise.resolve();
    const next = prev.then(() => this.run(adapter, opts), () => this.run(adapter, opts));
    this.chains.set(adapter.id, next.catch(() => undefined));
    return next;
  }

  /** 원본 단위 큐 안에서 fn 을 실행한다 (가져온 채팅 지우기가 그 원본의 동기화와 겹치지 않게). */
  exclusive<T>(sourceId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.chains.get(sourceId) ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this.chains.set(sourceId, next.catch(() => undefined));
    return next;
  }

  private finish(report: SyncReport, outcome: SyncReport['outcome'], reason?: string): SyncReport {
    report.outcome = outcome;
    if (reason) report.reason = reason;
    report.finishedAt = this.deps.now();
    this.deps.store.setState(report.source, 'last_report', JSON.stringify(report));
    return report;
  }

  private async run(adapter: SourceAdapter, opts: SyncOptions): Promise<SyncReport> {
    const { store } = this.deps;
    const source = adapter.id;
    const now = this.deps.now();
    const report = newReport(source, now);
    const full = !opts.only && !opts.onlyChar;

    const health = await adapter.health();
    if (health.status === 'unavailable') return this.finish(report, 'skipped', health.reasons.join('; ') || 'source unavailable');

    const fp = await adapter.fingerprint();
    if (fp === null) return this.finish(report, 'skipped', 'source fingerprint unavailable');
    if (full && !opts.force && store.getState(source, 'last_fp') === fp && !store.hasPendingOrDeferred(source)) {
      return this.finish(report, 'unchanged');
    }

    const result = await adapter.scan(async (ch) => {
      report.chars.seen++;
      try {
        await this.processCharacter(source, ch, opts, now, report);
      } catch {
        report.errors++; // 캐릭터 단위 격리: 내용 없는 고정 문구만 기록
      }
    }, { only: opts.only, onlyChar: opts.onlyChar });

    if (!result.complete) return this.finish(report, 'skipped', result.error ?? 'source scan incomplete');

    if (full) {
      const known = [
        ...store.liveCharIds(source).map((id) => `c:${id}`),
        ...store.liveChatKeys(source).map((k) => `h:${k.charId}/${k.chatId}`),
      ];
      const seen = new Set<string>();
      for (const [c, chats] of result.seen) { seen.add(`c:${c}`); for (const id of chats) seen.add(`h:${c}/${id}`); }
      const plan = planDeletions({ known, seen, accept: opts.acceptMassDeletion === true, ratio: this.deps.policy.massDeletionRatio });
      if (plan.held) {
        report.held = { items: known.length, missing: plan.missing };
      } else if (plan.tombstone.length) {
        const chars = plan.tombstone.filter((k) => k.startsWith('c:')).map((k) => k.slice(2));
        const chats = plan.tombstone
          .filter((k) => k.startsWith('h:'))
          .map((k) => { const rest = k.slice(2); const i = rest.indexOf('/'); return { charId: rest.slice(0, i), chatId: rest.slice(i + 1) }; })
          .filter((c) => !chars.includes(c.charId)); // 캐릭터와 함께 표시되는 채팅은 tombstoneChars 가 처리
        store.tx(() => {
          store.tombstoneChars(source, chars, now);
          store.tombstoneChats(source, chats, now);
        });
        report.chars.tombstoned = chars.length;
        report.chats.tombstoned = plan.tombstone.filter((k) => k.startsWith('h:')).length;
      }
      // 지문은 "이 소스 상태를 완전히 반영했다"는 뜻이다. 오류·읽을 수 없는 채팅·보류된 삭제가 있으면 확정하지 않아
      // 다음 동기화가 같은 소스를 다시 평가한다 (보류가 조용히 잊히는 것 방지).
      if (report.errors === 0 && result.unreadable === 0 && !report.held) store.setState(source, 'last_fp', fp);
    }
    return this.finish(report, 'synced');
  }

  private async processCharacter(source: string, ch: CharacterHandle, opts: SyncOptions, now: number, report: SyncReport) {
    const { store } = this.deps;
    store.upsertChar(source, ch.charId, ch.name, canon(ch.meta), now);
    this.syncCharImage(source, ch, now, report);
    const ruleNames = await this.cardRuleNames(source, ch);
    for (const read of ch.chats) {
      if (!read.ok) {
        report.chats.unreadable++;
        store.markChatError(source, ch.charId, read.chatId, read.reason);
        continue;
      }
      try {
        await this.processChat(source, ch, read.chat, opts, now, report, ruleNames.get(read.chat.chatId) ?? []);
      } catch {
        report.errors++;
        store.markChatError(source, ch.charId, read.chat.chatId, 'sync error');
      }
    }
  }

  /** 캐릭터의 카드 그림 규칙을 채팅마다 돌려 그림 이름을 얻는다 (워커, 캐릭터당 시간 제한). 넘기면 slow 로 기록. */
  private async cardRuleNames(source: string, ch: CharacterHandle): Promise<Map<string, string[]>> {
    const { store } = this.deps;
    const rules = Array.isArray(ch.meta.imageRules) ? (ch.meta.imageRules as RuleInput[]) : [];
    const ok = ch.chats.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    if (rules.length === 0 || ok.length === 0) { store.setImageRulesSlow(source, ch.charId, []); return new Map(); }
    const texts = ok.map((r) => r.chat.messages.map((m) => { const d = (m as { data?: unknown } | null)?.data; return typeof d === 'string' ? d : ''; }));
    const res = await ruleNamesInWorker(texts, rules, this.imageRuleBudgetMs);
    if ('slow' in res) { store.setImageRulesSlow(source, ch.charId, rules.map((r) => r.key)); return new Map(); }
    store.setImageRulesSlow(source, ch.charId, []);
    return new Map(ok.map((r, i) => [r.chat.chatId, [...new Set(res.names[i] ?? [])]]));
  }

  private async processChat(source: string, ch: CharacterHandle, chat: RawChat, opts: SyncOptions, now: number, report: SyncReport, ruleNames: string[] = []) {
    const { store, policy } = this.deps;
    const bodies = chat.messages.map(canon);
    const hashes = bodies.map(sha256Hex);
    const manifestHash = sha256Hex(hashes.join('\n'));
    const row = store.getChat(source, ch.charId, chat.chatId);
    const head = row?.headVersion != null ? store.getVersion(row.headVersion) : null;
    const headHashes = head ? store.getManifest(head.manifestHash) : null;
    const kind = classifyChat(headHashes, hashes);
    const decision = decideVersion({
      kind, manifestHash,
      pendingFp: row?.pendingFp ?? null, pendingSince: row?.pendingSince ?? null,
      now, debounceMs: policy.debounceMs, force: opts.force === true,
    });
    const metaJson = canon(chat.meta);

    // 에셋은 파일 IO 가 있으므로 트랜잭션 밖에서 해석·복사한다.
    const headRefs = head ? store.getVersionAssets(head.versionId) : [];
    const retryDeferred = headRefs.some((r) => r.status === 'deferred');
    const names = [...new Set([...ch.assetNames(chat.messages), ...ruleNames])];
    // 새 버전이 없어도 카드 그림 규칙 이름이 현재 버전에 빠져 있으면 채운다 (규칙이 나중에 생긴 경우)
    const known = new Set(headRefs.map((r) => r.ref));
    const missingRuleNames = head && decision.commit === null ? ruleNames.filter((n) => !known.has(n)) : [];
    let resolved: AssetRefRow[] | null = null;
    if (decision.commit !== null || retryDeferred) {
      resolved = this.resolveAssets(source, ch, names, headRefs, now, report);
    }
    const added = missingRuleNames.length ? this.resolveAssets(source, ch, missingRuleNames, [], now, report) : [];

    store.tx(() => {
      store.ensureChat(source, ch.charId, chat.chatId, chat.title, now);
      if (decision.commit) {
        const known = new Set(headHashes ?? []);
        store.putMsgs(hashes.map((hash, i) => ({ hash, json: bodies[i] as string })).filter((e) => !known.has(e.hash)));
        store.putManifest(manifestHash, hashes);
        const vid = store.insertVersion({
          source, charId: ch.charId, chatId: chat.chatId, createdAt: now,
          msgCount: hashes.length, manifestHash, metaJson, reason: decision.commit,
        });
        store.setVersionAssets(vid, resolved ?? []);
        store.setHead(source, ch.charId, chat.chatId, vid);
        if (decision.commit === 'initial') report.chats.created++;
        else if (decision.commit === 'appended') report.chats.appended++;
        else report.chats.edited++;
      } else {
        if (kind === 'unchanged') report.chats.unchanged++;
        if (decision.pending) report.chats.pending++;
        if (head) {
          if (head.metaJson !== metaJson) store.updateVersionMeta(head.versionId, metaJson); // 메타만 바뀜: 제자리 갱신
          if (resolved) {
            const was = new Map(headRefs.map((r) => [r.ref, r.status]));
            for (const r of resolved) {
              if (r.status === 'ok' && was.get(r.ref) === 'deferred') {
                store.updateVersionAsset(head.versionId, r.ref, r.hash, 'ok');
                report.assets.filled++;
              }
            }
          }
          if (added.length) store.setVersionAssets(head.versionId, added);
        }
      }
      store.updateChatState(source, ch.charId, chat.chatId, { lastDate: chat.lastDate, pending: decision.pending, fingerprint: manifestHash });
    });
  }

  /**
   * 이름 → (해시, 상태). 규칙:
   *  - head 에서 이미 ok 인 이름은 바이트를 다시 읽지 않는다 (계획 가정 5)
   *  - 해석 실패: 추적 대상(Asset Maid) 이름만 'unresolved' 로 기록, 그 밖은 조용히 무시
   *  - 같은 내용은 sha256 으로 1벌 (D15), 여유 공간이 부족하면 복사하지 않고 'deferred' (스펙 3.4.6)
   *  - hasAsset~참조 쓰기 구간(여기와 processChat 의 tx, syncCharImage)에 await 를 넣지 말 것: 지우기(dropUnusedAssets)와 겹치지 않는 근거다.
   */
  protected resolveAssets(
    _source: string, ch: CharacterHandle, names: string[], headRefs: AssetRefRow[], now: number, report: SyncReport,
  ): AssetRefRow[] {
    const { store, policy } = this.deps;
    const prev = new Map(headRefs.map((r) => [r.ref, r]));
    const out: AssetRefRow[] = [];
    for (const name of names) {
      const known = prev.get(name);
      if (known && known.status === 'ok') { out.push(known); continue; }
      const bytes = ch.readAsset(name);
      if (!bytes) {
        if (ch.isTrackedAssetName(name)) { out.push({ ref: name, hash: null, status: 'unresolved' }); report.assets.unresolved++; }
        continue;
      }
      const hash = sha256Hex(bytes);
      if (store.hasAsset(hash)) { out.push({ ref: name, hash, status: 'ok' }); report.assets.deduped++; continue; }
      if (policy.freeSpace().freeBytes - bytes.length < policy.stopAssetsFreeBytes) {
        out.push({ ref: name, hash: null, status: 'deferred' });
        report.assets.deferred++;
        continue;
      }
      store.putAssetBlob(hash, assetMime(bytes), bytes, now);
      out.push({ ref: name, hash, status: 'ok' });
      report.assets.copied++;
    }
    return out;
  }

  /** 캐릭터 대표 이미지 1장 (D27, D15 확장). 같은 참조·해시가 있으면 다시 읽지 않는다. 중복 제거·용량 정책은 채팅 에셋과 같다. */
  private syncCharImage(source: string, ch: CharacterHandle, now: number, report: SyncReport) {
    const { store, policy } = this.deps;
    const ref = ch.imageRef;
    if (!ref) { store.clearCharImage(source, ch.charId); return; }
    const cur = store.getCharImage(source, ch.charId);
    if (cur && cur.ref === ref && cur.hash && store.hasAsset(cur.hash)) return;
    const bytes = ch.readImage();
    if (!bytes) { store.setCharImage(source, ch.charId, ref, null); return; }
    const hash = sha256Hex(bytes);
    if (store.hasAsset(hash)) {
      report.assets.deduped++;
    } else if (policy.freeSpace().freeBytes - bytes.length < policy.stopAssetsFreeBytes) {
      report.assets.deferred++;
      store.setCharImage(source, ch.charId, ref, null);
      return;
    } else {
      store.putAssetBlob(hash, assetMime(bytes), bytes, now);
      report.assets.copied++;
    }
    store.setCharImage(source, ch.charId, ref, hash);
  }
}
