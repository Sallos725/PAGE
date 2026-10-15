import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'page-personal-'));
const rule = (o: Partial<Parameters<StateStore['addHideRule']>[1]> = {}) => ({
  scope: 'char' as const, charId: 'c1', name: '상태창', pattern: '<s>[\\s\\S]*?</s>', flags: 'g', enabled: true, origin: 'manual' as const, ...o,
});

describe('StateStore aliases', () => {
  it('sets, overwrites, maps and deletes per (source, kind, char, chat)', () => {
    const s = new StateStore(tmp());
    s.setAlias('main', 'char', 'c1', '', '하나', 1);
    s.setAlias('main', 'char', 'c1', '', '둘', 2);
    s.setAlias('main', 'chat', 'c1', 'a1', '채팅 별칭', 3);
    s.setAlias('main', 'chat', 'c2', 'a1', '다른 캐릭터', 4); // 같은 chat id, 다른 캐릭터
    expect(s.aliasMap('main', 'char')).toEqual(new Map([['c1', '둘']]));
    expect(s.aliasMap('main', 'chat', 'c1')).toEqual(new Map([['a1', '채팅 별칭']]));
    expect(s.aliasMap('alt', 'char').size).toBe(0);
    expect(s.deleteAlias('main', 'char', 'c1', '')).toBe(true);
    expect(s.deleteAlias('main', 'char', 'c1', '')).toBe(false);
    expect(s.aliasMap('main', 'char').size).toBe(0);
    s.close();
  });
});

describe('StateStore hide rules', () => {
  it('lists global rules plus the character\'s own, in creation order', () => {
    const s = new StateStore(tmp());
    const a = s.addHideRule('main', rule({ name: 'A' }), 10);
    const g = s.addHideRule('main', rule({ name: 'G', scope: 'global', charId: '' }), 20);
    s.addHideRule('main', rule({ name: 'other', charId: 'c2' }), 30);
    s.addHideRule('alt', rule({ name: 'alt' }), 40);
    expect(s.listHideRules('main', 'c1').map((r) => r.name)).toEqual(['A', 'G']);
    expect(a).toMatchObject({ scope: 'char', charId: 'c1', enabled: true, origin: 'manual', createdAt: 10, updatedAt: 10 });
    expect(g.charId).toBe('');
    expect(s.countHideRules('main')).toBe(3);
    s.close();
  });

  it('updates fields and deletes only within the source', () => {
    const s = new StateStore(tmp());
    const r = s.addHideRule('main', rule(), 10);
    expect(s.updateHideRule('alt', r.id, { enabled: false }, 11)).toBeNull();
    const u = s.updateHideRule('main', r.id, { enabled: false, name: '새 이름', pattern: 'x+', flags: 'gi' }, 12)!;
    expect(u).toMatchObject({ enabled: false, name: '새 이름', pattern: 'x+', flags: 'gi', createdAt: 10, updatedAt: 12 });
    expect(s.getHideRule('main', r.id)).toEqual(u);
    expect(s.deleteHideRule('alt', r.id)).toBe(false);
    expect(s.deleteHideRule('main', r.id)).toBe(true);
    expect(s.listHideRules('main', 'c1')).toEqual([]);
    s.close();
  });

  it('reopens an existing state.db and keeps the data', () => {
    const dir = tmp();
    const s = new StateStore(dir);
    s.addHideRule('main', rule(), 10);
    s.setAlias('main', 'char', 'c1', '', '하나', 1);
    s.close();
    const s2 = new StateStore(dir);
    expect(s2.listHideRules('main', 'c1')).toHaveLength(1);
    expect(s2.aliasMap('main', 'char').get('c1')).toBe('하나');
    s2.close();
  });
});
