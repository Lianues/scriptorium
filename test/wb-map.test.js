import test from 'node:test';
import assert from 'node:assert/strict';
import { docToEntry, entryToDoc, entryBaseName, safeSegment, uidFromBaseName } from '../lib/wb-map.js';

const entry = {
    uid: 3,
    key: ['千束', 'Chisato'],
    keysecondary: ['锦木'],
    comment: '锦木千束 - 档案',
    content: '正文内容',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 3,
    addMemo: true,
    order: 999,
    position: 4,
    disable: false,
    excludeRecursion: true,
    preventRecursion: false,
    delayUntilRecursion: 0,
    probability: 80,
    useProbability: true,
    depth: 6,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 2,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
    ignoreBudget: false,
};

test('entry -> doc：常用字段提升，其余进 other', () => {
    const { yaml, md } = entryToDoc(entry, 3);

    assert.equal(yaml.index, 3);
    assert.equal(yaml.name, '锦木千束 - 档案');
    assert.equal(yaml.activationMode, 'keyword');
    assert.equal(yaml.selectiveLogic, 'andAll');
    assert.equal(yaml.position, 'fixed');
    assert.equal(yaml.role, 'model');
    assert.equal(yaml.probability, 80);
    assert.equal(yaml.order, 999);
    assert.equal(yaml.depth, 6);
    assert.equal(yaml.caseSensitive, null);

    assert.equal(yaml.other.selective, true);
    assert.equal(yaml.other.addMemo, true);
    assert.equal(yaml.other.delayUntilRecursion, 0);
    assert.equal(md, '正文内容');

    // 不重复的字段
    assert.equal('content' in yaml, false);
    assert.equal('comment' in yaml, false);
    assert.equal('uid' in yaml.other, false);
});

test('doc -> entry：能还原回酒馆字段', () => {
    const { yaml, md } = entryToDoc(entry, 3);
    const { entry: back, warnings } = docToEntry(yaml, md, null);

    assert.deepEqual(warnings, []);
    assert.equal(back.uid, 3);
    assert.equal(back.comment, '锦木千束 - 档案');
    assert.equal(back.content, '正文内容');
    assert.deepEqual(back.key, ['千束', 'Chisato']);
    assert.deepEqual(back.keysecondary, ['锦木']);
    assert.equal(back.selectiveLogic, 3);
    assert.equal(back.constant, false);
    assert.equal(back.vectorized, false);
    assert.equal(back.disable, false);
    assert.equal(back.position, 4);
    assert.equal(back.role, 2);
    assert.equal(back.probability, 80);
    assert.equal(back.order, 999);
    assert.equal(back.depth, 6);
    assert.equal(back.selective, true);
    assert.equal(back.addMemo, true);
    assert.equal(back.useProbability, true);
});

test('doc -> entry：索引缺失时用文件名兜底，并给出警告', () => {
    const { entry: back, warnings } = docToEntry({ name: 'x' }, 'body', 7);
    assert.equal(back.uid, 7);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /index/);
});

test('doc -> entry：mode / position / logic 非法时降级并警告', () => {
    const { entry: back, warnings } = docToEntry({
        index: 1,
        activationMode: 'sometimes',
        position: 'weird',
        selectiveLogic: 'nonsense',
        probability: 300,
    }, '');

    assert.equal(back.constant, false);
    assert.equal(back.vectorized, false);
    assert.equal(back.position, 0);
    assert.equal(back.selectiveLogic, 0);
    assert.equal(back.probability, 100);
    assert.equal(warnings.length, 3);
});

test('doc -> entry：always / vector 映射到 constant / vectorized', () => {
    assert.equal(docToEntry({ index: 1, activationMode: 'always' }, '').entry.constant, true);
    assert.equal(docToEntry({ index: 2, activationMode: 'vector' }, '').entry.vectorized, true);
});

test('doc -> entry：position 非 fixed 时 role 归零', () => {
    const { entry: back } = docToEntry({ index: 1, position: 'beforeChar', role: 'model' }, '');
    assert.equal(back.role, 0);
});

test('文件名工具', () => {
    assert.equal(entryBaseName(7, 'Alice / 爱丽丝'), '7_Alice _ 爱丽丝');
    assert.equal(uidFromBaseName('12_标题'), 12);
    assert.equal(uidFromBaseName('标题'), null);
    assert.equal(safeSegment('a/b:c*'), 'a_b_c_');
    assert.equal(safeSegment('...  .'), '');
    assert.equal(safeSegment(''), '');
});
