import './setup.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DIRECTORY_BOOK,
    DIRECTORY_COMMENT,
    DIRECTORY_WORLD,
    appendDirectoryEntry,
    buildDirectoryContent,
    buildDirectoryEntry,
    buildTree,
    removeLegacyDirectoryEntry,
} from '../lib/directory.js';
import { Scriptorium } from '../lib/workspace.js';

/**
 * @param {Record<string, any>} books
 * @param {Record<string, any>} [options]
 */
function makeContext(books = {}, options = {}) {
    const globalSelect = options.globalSelect ?? [];
    const worldBooks = { ...books };

    return {
        chatMetadata: {},
        chatId: 'chat-A',
        getCurrentChatId: () => 'chat-A',
        saveMetadataDebounced() { },
        saveSettingsDebounced() { },
        characters: [],
        characterId: 0,
        powerUserSettings: { world_info: { globalSelect } },
        getWorldInfoNames: () => Object.keys(worldBooks),
        loadWorldInfo: async name => (worldBooks[name] ? structuredClone({ entries: worldBooks[name] }) : null),
        saveWorldInfo: async (name, data) => {
            worldBooks[name] = structuredClone(data.entries);
        },
        worldBooks,
        globalSelect,
    };
}

/**
 * @param {any} context
 * @returns {Promise<Scriptorium>}
 */
async function makeWorkspace(context) {
    const ws = new Scriptorium(context, { storage: null });
    await ws.ensure();
    return ws;
}

test('buildTree：按目录层级渲染，目录带斜杠', async () => {
    const context = makeContext();
    const ws = await makeWorkspace(context);
    ws.fs.write('/world_book/书/entries/0_a.md', 'A');
    ws.fs.write('/world_book/书/entries/0_a.yaml', 'name: a');

    const tree = buildTree(ws.fs);
    assert.equal(tree.books, 1);
    assert.equal(tree.files, 2);

    const text = tree.lines.join('\n');
    assert.match(text, /^\/world_book\/$/m);
    assert.match(text, /书\//);
    assert.match(text, /0_a\.md/);
});

test('buildDirectoryContent：带书数、文件数和用法示例', async () => {
    const context = makeContext();
    const ws = await makeWorkspace(context);
    ws.fs.write('/world_book/书/entries/0_a.md', 'A');

    const content = buildDirectoryContent(ws.fs);
    assert.match(content, /1 本世界书、1 个文件/);
    assert.match(content, /read/);
    assert.match(content, /grep/);
    assert.match(content, /被禁用的条目不在镜像里/);
});

test('buildDirectoryContent：没有启用世界书时明确告诉模型目录是空的', async () => {
    const context = makeContext();
    const ws = await makeWorkspace(context);

    const content = buildDirectoryContent(ws.fs);
    assert.match(content, /没有启用任何世界书/);
    assert.doesNotMatch(content, /```/);
});

test('buildDirectoryEntry：常驻、before、order 极低、不占预算、不递归', () => {
    const entry = buildDirectoryEntry('目录正文');
    assert.equal(entry.world, DIRECTORY_WORLD);
    assert.equal(entry.content, '目录正文');
    assert.equal(entry.constant, true);
    assert.equal(entry.disable, false);
    assert.equal(entry.position, 0);
    assert.equal(entry.ignoreBudget, true);
    assert.equal(entry.preventRecursion, true);
    assert.equal(entry.excludeRecursion, true);
    assert.deepEqual(entry.triggers, []);
    assert.deepEqual(entry.characterFilter, { isExclude: false, names: [], tags: [] });
    // 必须能被 structuredClone（酒馆扫描前会深拷贝）
    assert.deepEqual(structuredClone(entry), entry);
});

test('appendDirectoryEntry：插进 globalLore，按酒馆的排序规则落在 World Info (before) 开头', () => {
    const globalLore = [
        { uid: 1, world: '书', order: 100, position: 0, content: '甲' },
        { uid: 2, world: '书', order: 0, position: 0, content: '乙' },
        { uid: 3, world: '书', order: -50, position: 0, content: '丙' },
    ];
    const payload = { globalLore, characterLore: [], chatLore: [], personaLore: [] };

    assert.equal(appendDirectoryEntry(payload, '目录'), true);
    assert.equal(globalLore.length, 4);

    // 复刻 world-info.js：sortFn = b.order - a.order，然后逐个 unshift
    const before = [];
    [...globalLore].sort((a, b) => b.order - a.order).forEach(entry => before.unshift(entry.content));
    assert.equal(before[0], '目录');

    // 同一次扫描重复触发不会插两条
    assert.equal(appendDirectoryEntry(payload, '目录'), false);
    assert.equal(globalLore.length, 4);
});

test('appendDirectoryEntry：还没同步出目录 / 参数不对时不插', () => {
    const globalLore = [];
    assert.equal(appendDirectoryEntry({ globalLore }, ''), false);
    assert.equal(appendDirectoryEntry(undefined, '目录'), false);
    assert.equal(appendDirectoryEntry({}, '目录'), false);
    assert.equal(globalLore.length, 0);
});

/**
 * 模拟旧版写进世界书的目录条目。
 * @param {number} uid
 * @param {string} [content]
 */
function legacyEntry(uid, content = '旧目录') {
    return { uid, comment: DIRECTORY_COMMENT, content, constant: true };
}

test('removeLegacyDirectoryEntry：摘掉旧版写进启用世界书的条目，只跑一次', async () => {
    const context = makeContext({
        测试书: { 0: { uid: 0, comment: '正常条目', content: 'A' }, 1: legacyEntry(1) },
    });
    context.extensionSettings = { scriptorium: { directoryLocation: { book: '测试书', uid: 1 } } };

    assert.equal(await removeLegacyDirectoryEntry(context), true);
    assert.deepEqual(Object.keys(context.worldBooks['测试书']), ['0']);
    assert.equal(context.extensionSettings.scriptorium.directoryLocation, undefined);

    // 记录已经删掉，再调就什么都不做
    assert.equal(await removeLegacyDirectoryEntry(context), false);
});

test('removeLegacyDirectoryEntry：旧版自建目录书会被清空并取消启用', async () => {
    const context = makeContext({ [DIRECTORY_BOOK]: { 0: legacyEntry(0) } }, { globalSelect: [DIRECTORY_BOOK, '别的书'] });
    context.extensionSettings = { scriptorium: { directoryLocation: { book: DIRECTORY_BOOK, uid: 0 } } };

    assert.equal(await removeLegacyDirectoryEntry(context), true);
    assert.deepEqual(context.worldBooks[DIRECTORY_BOOK], {});
    assert.deepEqual(context.globalSelect, ['别的书']);
});

test('removeLegacyDirectoryEntry：没有旧版记录时不碰世界书', async () => {
    let saved = 0;
    const context = makeContext({ 测试书: { 0: legacyEntry(0) } });
    context.extensionSettings = { scriptorium: {} };
    context.saveWorldInfo = async () => {
        saved += 1;
    };

    assert.equal(await removeLegacyDirectoryEntry(context), false);
    assert.equal(saved, 0);
});

test('importBook：旧版目录条目本身不进镜像', async () => {
    const context = makeContext({ 测试书: { 0: { uid: 0, comment: '正常', content: 'A' }, 1: legacyEntry(1) } });
    const ws = await makeWorkspace(context);

    await ws.importBook('测试书');
    const files = ws.fs.files('/world_book/测试书');
    assert.equal(files.some(path => path.includes('世界书目录')), false);
    assert.equal(files.some(path => path.includes('正常')), true);
});
