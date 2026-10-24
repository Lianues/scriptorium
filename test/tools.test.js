import './setup.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers, registerWorkspaceTools, TOOL_NAMES } from '../lib/tools.js';
import { Scriptorium } from '../lib/workspace.js';

/**
 * @returns {{ws: Scriptorium, tools: any}}
 */
function makeTools() {
    const context = {
        chatMetadata: {},
        chatId: 'chat-A',
        getCurrentChatId: () => 'chat-A',
        saveMetadataDebounced() { },
        characters: [],
        characterId: 0,
        powerUserSettings: { world_info: { globalSelect: [] } },
        getWorldInfoNames: () => [],
        loadWorldInfo: async () => null,
        saveWorldInfo: async () => { },
    };

    const ws = new Scriptorium(context, { storage: null });
    return { ws, tools: createToolHandlers(ws) };
}

test('只有 read / grep 两个工具', () => {
    assert.deepEqual(TOOL_NAMES, ['read', 'grep']);
});

test('注册：名字和描述都对得上', () => {
    /** @type {any[]} */
    const registered = [];
    const context = { registerFunctionTool: tool => registered.push(tool), unregisterFunctionTool() { } };
    registerWorkspaceTools(context, { isBound: () => true });

    assert.deepEqual(registered.map(tool => tool.name), ['read', 'grep']);
    assert.match(registered[1].description, /ripgrep/i);
});

test('read：文件内容、行范围、目录列表', async () => {
    const { ws, tools } = makeTools();
    await ws.ensure();
    ws.fs.write('/world_book/书/entries/0_a.md', 'line1\nline2\nline3');

    assert.equal(await tools.read({ path: '/world_book/书/entries/0_a.md' }), 'line1\nline2\nline3');
    assert.equal(
        await tools.read({ path: '/world_book/书/entries/0_a.md', startLine: 2, endLine: 2 }),
        '# /world_book/书/entries/0_a.md lines 2-2 of 3\nline2',
    );
    assert.match(await tools.read({ path: '/world_book/书' }), /entries\//);
    await assert.rejects(() => tools.read({ path: '/nope.md' }), /文件不存在/);
});

test('grep：接受 rg 风格参数串', async () => {
    const { ws, tools } = makeTools();
    await ws.ensure();
    ws.fs.write('/world_book/书/entries/0_a.md', '千束站在门口。\n千束笑了。');
    ws.fs.write('/world_book/书/entries/0_a.yaml', 'name: 千束\n');

    const text = await tools.grep({ args: '千束 -C 0 /world_book' });
    assert.match(text, /0_a\.md:1:1: 千束站在门口。/);
    assert.match(text, /3 条命中/);

    const yamlOnly = await tools.grep({ args: '千束 -g "*.yaml"' });
    assert.match(yamlOnly, /0_a\.yaml:1:7/);
    assert.doesNotMatch(yamlOnly, /\.md:/);

    const counted = await tools.grep({ args: '千束 -c /world_book' });
    assert.match(counted, /0_a\.md: 2/);
});

test('grep：报错能看懂', async () => {
    const { ws, tools } = makeTools();
    await ws.ensure();

    await assert.rejects(() => tools.grep({ args: '' }), /缺少 pattern/);
    await assert.rejects(() => tools.grep({ args: 'x -Z' }), /不认识的选项/);

    ws.fs.write('/world_book/书/entries/0_a.md', '两个词');
    await assert.rejects(() => tools.grep({ args: '两个 词 /world_book/不存在' }), /请用引号/);
});
