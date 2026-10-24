import './setup.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Scriptorium, META_KEY, BOOK_ROOT } from '../lib/workspace.js';

/**
 * @param {string} chatId
 * @param {Record<string, any>} meta
 * @param {Record<string, any>} books
 * @param {Record<string, any>} [overrides]
 */
function makeContext(chatId, meta, books, overrides = {}) {
    const globalSelect = overrides.globalSelect ?? [];

    return {
        chatMetadata: meta,
        chatId,
        getCurrentChatId: () => chatId,
        saveMetadataDebounced() { },
        saveSettingsDebounced() { },
        characters: overrides.characters ?? [],
        characterId: overrides.characterId ?? 0,
        powerUserSettings: { world_info: { globalSelect } },
        getWorldInfoNames: () => Object.keys(books),
        loadWorldInfo: async name => (books[name] ? structuredClone({ entries: books[name] }) : null),
        saveWorldInfo: async (name, data) => {
            books[name] = structuredClone(data.entries);
        },
    };
}

test('ensure：只建 /world_book 和 README，不再有 chat_history', async () => {
    const ws = new Scriptorium(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();

    assert.equal(ws.fs.isDir(BOOK_ROOT), true);
    assert.equal(ws.fs.isDir('/chat_history'), false);
    assert.equal(ws.fs.exists('/README.md'), true);
    assert.match(ws.fs.read('/README.md'), /Scriptorium/);
});

test('importBook：每个启用条目一个 md（只有正文），不再有 yaml / entries 目录', async () => {
    const meta = {};
    const books = {
        书: {
            0: { uid: 0, comment: '千束', content: '正文A', disable: false, key: ['千束'] },
            1: { uid: 1, comment: '隐藏', content: '不该出现', disable: true, key: [] },
        },
    };

    const ws = new Scriptorium(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();

    const result = await ws.importBook('书');
    assert.equal(result.created, 1); // 只有启用条目，一条一个 md
    assert.equal(result.disabled, 1);
    assert.equal(result.total, 2);

    const files = ws.fs.files().filter(path => path.startsWith(`${BOOK_ROOT}/`));
    assert.equal(files.some(path => path.endsWith('.md') && path.includes('千束')), true);
    assert.equal(files.some(path => path.includes('隐藏')), false);
    assert.equal(ws.fs.read(`${BOOK_ROOT}/书/0_千束.md`), '正文A');
    assert.deepEqual(files, [`${BOOK_ROOT}/书/0_千束.md`]);
    assert.equal(files.some(path => path.endsWith('.yaml')), false);
});

test('importAll：按传入的名单同步，reset 会清掉旧目录', async () => {
    const meta = {};
    const books = {
        甲: { 0: { uid: 0, comment: 'a', content: 'A' } },
        乙: { 0: { uid: 0, comment: 'b', content: 'B' } },
    };

    const ws = new Scriptorium(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();

    await ws.importAll('reset', ['甲', '乙']);
    assert.deepEqual(ws.bookDirs().map(item => item.book).sort(), ['乙', '甲']);

    // 乙被关掉：下一次只同步甲，乙目录消失
    await ws.importAll('reset', ['甲']);
    assert.deepEqual(ws.bookDirs().map(item => item.book), ['甲']);
});

test('activeBooks：聊天绑定 + 角色绑定 + 全局多选，且过滤掉不存在的书', async () => {
    const meta = { world_info: '聊天书' };
    const books = { 聊天书: {}, 角色书: {}, 全局书: {} };
    const characters = [{ data: { extensions: { world: '角色书' } } }];

    const ws = new Scriptorium(makeContext('chat-A', meta, books, {
        characters,
        characterId: 0,
        globalSelect: ['全局书', '不存在的书'],
    }), { storage: null });

    const active = await ws.activeBooks();
    assert.deepEqual(active.sort(), ['全局书', '聊天书', '角色书'].sort());
});

test('removeInactiveBooks：移除不在启用列表里的目录', async () => {
    const meta = {};
    const books = {
        甲: { 0: { uid: 0, comment: 'a', content: 'A' } },
        乙: { 0: { uid: 0, comment: 'b', content: 'B' } },
    };

    const ws = new Scriptorium(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();
    await ws.importAll('reset', ['甲', '乙']);

    const removed = await ws.removeInactiveBooks(['甲']);
    assert.deepEqual(removed.map(item => item.book), ['乙']);
    assert.deepEqual(ws.bookDirs().map(item => item.book), ['甲']);
});

test('指针写在 chat_metadata.scriptorium，分支会克隆出独立副本', async () => {
    const meta = {};
    const books = { 书: { 0: { uid: 0, comment: 'a', content: 'A' } } };

    const ws = new Scriptorium(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();
    await ws.importBook('书');

    assert.equal(meta[META_KEY].owner, 'chat-A');

    const branchMeta = structuredClone(meta);
    const branch = new Scriptorium(makeContext('chat-B', branchMeta, books), { storage: null });
    await branch.ready();

    assert.notEqual(branchMeta[META_KEY].sid, meta[META_KEY].sid);
    assert.equal(branchMeta[META_KEY].owner, 'chat-B');
});
