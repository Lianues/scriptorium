import './setup.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { dumpYaml, parseYaml } from '../lib/yaml.js';

test('往返：条目 yaml 保持结构', () => {
    const obj = {
        index: 0,
        name: 'LycoReco具体资料',
        enabled: true,
        activationMode: 'keyword',
        key: ['LycoReco', '咖啡厅', '咖啡馆'],
        secondaryKey: [],
        selectiveLogic: 'andAny',
        role: null,
        caseSensitive: null,
        excludeRecursion: true,
        preventRecursion: true,
        probability: 100,
        position: 'beforeChar',
        order: 17,
        depth: 4,
        other: {
            selective: true,
            group: '',
            sticky: 0,
            triggers: [],
            extensions: { display_index: 0, ignore_budget: false },
        },
    };

    const text = dumpYaml(obj);
    assert.deepEqual(parseYaml(text), obj);

    // 排版：块序列缩进两格、空数组内联、空字符串加引号
    assert.match(text, /^key:$/m);
    assert.match(text, /^ {2}- LycoReco$/m);
    assert.match(text, /^secondaryKey: \[\]$/m);
    assert.match(text, /^ {2}group: ""$/m);
    assert.match(text, /^role: null$/m);
});

test('dump：需要引号的值会被引起来', () => {
    const obj = {
        name: '- AET - 手写修正 - 莉可丽丝 V4.1',
        colon: 'a: b',
        numeric: '123',
        empty: '',
        multi: 'line1\nline2',
    };

    const text = dumpYaml(obj);
    assert.deepEqual(parseYaml(text), obj);
    assert.match(text, /name: "- AET/);
    assert.match(text, /numeric: "123"/);
});

test('dump：长字符串不折行（lineWidth: 0）', () => {
    const long = '这是一段很长的描述'.repeat(20);
    const text = dumpYaml({ description: long });
    assert.equal(parseYaml(text).description, long);
    assert.equal(text.trim().split('\n').length, 1);
});

test('parse：注释 / 单引号 / 流式集合 / 块标量', () => {
    const text = [
        '# leading comment',
        'name: demo  # trailing',
        'enabled: yes',
        'nothing:',
        'n: ~',
        'num: 1.5',
        "quoted: 'it''s'",
        'list: [a, "b, c", 3]',
        'emptyList: []',
        'emptyMap: {}',
        'flow: {a: 1, b: two}',
        'desc: |-',
        '  line1',
        '    line2',
        '',
        '  line3',
        'tail: end',
    ].join('\r\n');

    const obj = parseYaml(text);
    assert.equal(obj.name, 'demo');
    assert.equal(obj.enabled, 'yes'); // yaml 1.2：yes/no 是字符串，不是布尔
    assert.equal(obj.nothing, null);
    assert.equal(obj.n, null);
    assert.equal(obj.num, 1.5);
    assert.equal(obj.quoted, "it's");
    assert.deepEqual(obj.list, ['a', 'b, c', 3]);
    assert.deepEqual(obj.emptyList, []);
    assert.deepEqual(obj.emptyMap, {});
    assert.deepEqual(obj.flow, { a: 1, b: 'two' });
    assert.equal(obj.desc, 'line1\n  line2\n\nline3');
    assert.equal(obj.tail, 'end');
});

test('parse：数组里的对象', () => {
    const text = [
        'entries:',
        '  - index: 1',
        '    name: one',
        '    keys:',
        '      - a',
        '      - b',
        '  - index: 2',
        '    name: two',
        'other:',
        '  - plain',
    ].join('\n');

    const obj = parseYaml(text);
    assert.deepEqual(obj.entries, [
        { index: 1, name: 'one', keys: ['a', 'b'] },
        { index: 2, name: 'two' },
    ]);
    assert.deepEqual(obj.other, ['plain']);
});

test('parse：空文本与纯注释返回空对象', () => {
    assert.deepEqual(parseYaml(''), {});
    assert.deepEqual(parseYaml('   \n'), {});
    assert.deepEqual(parseYaml('# only comment\n\n'), {});
});

test('parse：非法内容会抛错（带行号）', () => {
    assert.throws(() => parseYaml('a: [1, 2'), /./);
    assert.throws(() => parseYaml('just a string'), /映射/);
    assert.throws(() => parseYaml('- a\n- b'), /映射/);
});

test('dump：只接受对象根节点', () => {
    assert.throws(() => dumpYaml([]), /对象/);
    assert.throws(() => dumpYaml(null), /对象/);
});
