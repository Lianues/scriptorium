import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyReasoningBackfill,
    collectToolReasoning,
    findAssistantMessagesMissingReasoning,
    installReasoningBackfill,
    needsReasoningBackfill,
} from '../lib/reasoning-backfill.js';

const REASONING = 'The user asks to demonstrate read. Let me list /world_book directory.';

/** @returns {any[]} */
function chatWithInvocation() {
    return [
        { role: 'user', mes: '演示一下read' },
        {
            is_system: true,
            extra: {
                tool_invocations: [
                    {
                        id: 'call_00_yBas2EWpl8CD4sm9ZjiS7455',
                        name: 'read',
                        parameters: '{"path":"/world_book"}',
                        result: '/world_book (空目录)',
                        reasoning: REASONING,
                        signature: null,
                    },
                ],
            },
        },
        { role: 'assistant', mes: '读到了。' },
    ];
}

/** @returns {Record<string, any>} */
function requestData(overrides = {}) {
    return {
        chat_completion_source: 'deepseek',
        model: 'deepseek-flash',
        messages: [
            { role: 'system', content: '预设开头' },
            { role: 'user', content: '演示一下read' },
            {
                role: 'assistant',
                content: '我来实际读一下看看。',
            },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'call_00_yBas2EWpl8CD4sm9ZjiS7455',
                        type: 'function',
                        function: { name: 'read', arguments: '{"path":"/world_book"}' },
                    },
                ],
            },
            { role: 'tool', content: '/world_book (空目录)', tool_call_id: 'call_00_yBas2EWpl8CD4sm9ZjiS7455' },
        ],
        ...overrides,
    };
}

test('collectToolReasoning：从 tool_invocations 里收集 id -> 推理', () => {
    const map = collectToolReasoning(chatWithInvocation());
    assert.equal(map.get('call_00_yBas2EWpl8CD4sm9ZjiS7455'), REASONING);
    assert.equal(map.size, 1);
});

test('collectToolReasoning：非数组 / 空聊天不炸', () => {
    assert.equal(collectToolReasoning(undefined).size, 0);
    assert.equal(collectToolReasoning([]).size, 0);
    assert.equal(collectToolReasoning([{ extra: {} }]).size, 0);
});

test('needsReasoningBackfill：deepseek 源、custom+deepseek 需要，其他不用', () => {
    assert.equal(needsReasoningBackfill({ chat_completion_source: 'deepseek' }), true);
    assert.equal(needsReasoningBackfill(
        { chat_completion_source: 'custom', model: 'deepseek-flash' },
        { custom_url: 'https://api.deepseek.com/v1' },
    ), true);
    assert.equal(needsReasoningBackfill(
        { chat_completion_source: 'custom', model: 'gpt-4o' },
        { custom_url: 'https://api.openai.com/v1' },
    ), false);
    assert.equal(needsReasoningBackfill({ chat_completion_source: 'openrouter', model: 'deepseek/deepseek-chat' }), false);
});

test('回填：推理只挂在前面那条正文消息上，工具消息保持原样', () => {
    const data = requestData();
    const patched = applyReasoningBackfill(data, chatWithInvocation());

    assert.equal(patched, 1);
    // 正文消息拿到推理
    assert.equal(data.messages[2].reasoning_content, REASONING);
    // 带 tool_calls 的那条不动
    const toolMessage = data.messages.find(m => Array.isArray(m.tool_calls));
    assert.equal('reasoning_content' in toolMessage, false);
    // system / user 不受影响
    assert.equal('reasoning_content' in data.messages[0], false);
    assert.equal('reasoning_content' in data.messages[1], false);
});

test('回填：模型只回了工具调用（前面没有正文）时，退回挂在工具消息上', () => {
    const data = requestData({
        messages: [
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call_00_yBas2EWpl8CD4sm9ZjiS7455', type: 'function', function: { name: 'read', arguments: '{}' } }],
            },
        ],
    });

    assert.equal(applyReasoningBackfill(data, chatWithInvocation()), 1);
    assert.equal(data.messages[1].reasoning_content, REASONING);
});

test('回填：已有非空 reasoning_content 不覆盖', () => {
    const data = requestData();
    const toolMessage = data.messages.find(m => Array.isArray(m.tool_calls));
    toolMessage.reasoning_content = '原有推理';

    assert.equal(applyReasoningBackfill(data, chatWithInvocation()), 0);
    assert.equal(toolMessage.reasoning_content, '原有推理');
});

test('回填：工具消息上的空串（ST 补的占位）不影响正文回填', () => {
    const data = requestData();
    const toolMessage = data.messages.find(m => Array.isArray(m.tool_calls));
    toolMessage.reasoning_content = '';

    assert.equal(applyReasoningBackfill(data, chatWithInvocation()), 1);
    assert.equal(data.messages[2].reasoning_content, REASONING);
    assert.equal(toolMessage.reasoning_content, '');
});

test('回填：聊天记录里没有对应推理时保持原样', () => {
    const data = requestData();
    const patched = applyReasoningBackfill(data, []);
    assert.equal(patched, 0);
    assert.equal('reasoning_content' in data.messages[3], false);
});

test('回填：多个 tool_calls 共享同一轮推理，取第一个能对上的', () => {
    const data = requestData({
        messages: [
            {
                role: 'assistant',
                tool_calls: [
                    { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{}' } },
                    { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{}' } },
                ],
            },
        ],
    });
    const chat = [{ extra: { tool_invocations: [{ id: 'call_b', reasoning: 'B 的推理' }] } }];

    assert.equal(applyReasoningBackfill(data, chat), 1);
    assert.equal(data.messages[0].reasoning_content, 'B 的推理');
});

test('回填：没有工具消息时不做任何事', () => {
    const data = { messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(applyReasoningBackfill(data, chatWithInvocation()), 0);
});

test('回填：普通 assistant 消息的 reasoning 也复制成 reasoning_content', () => {
    const data = requestData();
    data.messages.push({ role: 'assistant', content: '之前的回复', reasoning: '之前的推理' });

    assert.equal(applyReasoningBackfill(data, chatWithInvocation()), 2);
    assert.equal(data.messages.at(-1).reasoning_content, '之前的推理');
});

test('findAssistantMessagesMissingReasoning：指出还差哪几条', () => {
    const data = requestData();
    const missing = findAssistantMessagesMissingReasoning(data.messages);

    // 普通 assistant 消息 + 带 tool_calls 的消息，都还没有 reasoning_content
    assert.equal(missing.length, 2);
    assert.deepEqual(missing.map(item => item.hasToolCalls), [false, true]);

    applyReasoningBackfill(data, chatWithInvocation());

    // 正文那条补上了；工具那条按策略不补，仍然"缺"
    const after = findAssistantMessagesMissingReasoning(data.messages);
    assert.equal(after.length, 1);
    assert.equal(after[0].hasToolCalls, true);
});

test('findAssistantMessagesMissingReasoning：user / tool 消息不算', () => {
    const messages = [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'x', tool_call_id: 'a' },
        { role: 'assistant', content: 'ok' },
    ];
    const missing = findAssistantMessagesMissingReasoning(messages);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].index, 2);
    assert.equal(missing[0].hasToolCalls, false);
});

test('install：包一层后调用会回填，卸载后恢复', async () => {
    class FakeToolManager {
        static calls = 0;
        static async registerFunctionToolsOpenAI(target) {
            FakeToolManager.calls += 1;
            target.tools = [{ type: 'function' }];
        }
    }

    const context = {
        ToolManager: FakeToolManager,
        chatCompletionSettings: { chat_completion_source: 'deepseek' },
        chat: chatWithInvocation(),
    };

    const uninstall = installReasoningBackfill(context);
    assert.ok(FakeToolManager.__scOriginalRegisterFunctionTools);

    const data = requestData();
    await FakeToolManager.registerFunctionToolsOpenAI(data);
    assert.equal(FakeToolManager.calls, 1);
    assert.equal(data.messages[2].reasoning_content, REASONING);

    uninstall();
    assert.equal('__scOriginalRegisterFunctionTools' in FakeToolManager, false);

    const next = requestData();
    await FakeToolManager.registerFunctionToolsOpenAI(next);
    assert.equal('reasoning_content' in next.messages[2], false);
});

test('install：重复安装不叠加', () => {
    class FakeToolManager {
        static async registerFunctionToolsOpenAI() { }
    }
    const context = { ToolManager: FakeToolManager, chatCompletionSettings: {}, chat: [] };
    const first = installReasoningBackfill(context);
    installReasoningBackfill(context);
    assert.ok(FakeToolManager.__scOriginalRegisterFunctionTools);
    first();
    assert.equal('__scOriginalRegisterFunctionTools' in FakeToolManager, false);
});
