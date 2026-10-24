/**
 * 工具调用消息的 reasoning_content 回填。
 *
 * 背景：
 *   DeepSeek 思考模式要求"带 tool_calls 的 assistant 消息"把 reasoning_content 传回，
 *   否则下一轮直接 400：
 *     The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 *   ST 的处理是分裂的：
 *   1. 客户端只在 openrouter / custom 源下才把推理挂到 tool_calls 消息上
 *      （openai.js 的 interleaved_reasoning_providers + tool_reasoning_mode，默认还是 disabled），
 *      deepseek 源下 `Message.setToolCalls(..., includeReasoning=false)` 直接把推理丢掉；
 *   2. 服务端 sendDeepSeekRequest 只补一个空串占位（addReasoningContentToToolCalls），
 *      新版 API 不认空串。
 *
 *   ！但真实推理并没有丢：它一直在 `chat[i].extra.tool_invocations[].reasoning` 里
 *   （工具执行时连 reasoningText 一起存下来的）。
 *
 * 做法：
 *   在每个请求组装完、发出之前，按 tool_call id 把那份真实推理捞出来，
 *   填进同名消息的 reasoning_content。服务端看到字段已存在就不再补空串。
 */

/**
 * 从聊天记录里收集 tool_call id -> 推理文本。
 * @param {any[]} chat
 * @returns {Map<string, string>}
 */
export function collectToolReasoning(chat) {
    /** @type {Map<string, string>} */
    const map = new Map();
    if (!Array.isArray(chat)) return map;

    for (const message of chat) {
        const invocations = message?.extra?.tool_invocations;
        if (!Array.isArray(invocations)) continue;

        for (const invocation of invocations) {
            if (!invocation?.id) continue;
            const text = typeof invocation.reasoning === 'string' ? invocation.reasoning.trim() : '';
            if (text) map.set(String(invocation.id), text);
        }
    }

    return map;
}

/**
 * 这次请求是不是指向 DeepSeek（需要 reasoning_content）。
 * @param {Record<string, any>} data
 * @param {Record<string, any>} [settings]
 * @returns {boolean}
 */
export function needsReasoningBackfill(data, settings) {
    const source = data?.chat_completion_source;
    if (source === 'deepseek') return true;
    if (source !== 'custom') return false;

    const url = String(settings?.custom_url ?? data.custom_url ?? '');
    const model = String(data.model ?? '');
    return /deepseek/i.test(url) || /deepseek/i.test(model);
}

/**
 * 把真实推理回填进请求消息。
 *
 * 两步：
 *  1. 带 tool_calls 的消息：按 tool_call id 去聊天记录里找当轮推理；
 *  2. 普通 assistant 消息：ST 只发自己的 `reasoning` 字段，这里顺手复制成
 *     `reasoning_content`（DeepSeek 的思考链校验可能会逐条检查）。
 *
 * @param {Record<string, any>} data 请求数据（generate_data），原地修改
 * @param {any[]} chat 聊天记录
 * @returns {number} 回填了几条
 */
export function applyReasoningBackfill(data, chat) {
    const messages = data?.messages;
    if (!Array.isArray(messages)) return 0;

    /** 只有存在"缺推理的 assistant 消息"时才去扫聊天记录 */
    const needsWork = messages.some(message => message?.role === 'assistant' && !hasReasoning(message));
    if (!needsWork) return 0;

    const reasoningById = collectToolReasoning(chat);
    let patched = 0;

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message || message.role !== 'assistant' || hasReasoning(message)) continue;

        if (isToolCallMessage(message)) {
            if (!reasoningById.size) continue;
            // 同一条消息里多个 tool_calls 共享同一轮推理，取第一个能对上的
            const text = message.tool_calls
                .map(toolCall => reasoningById.get(String(toolCall?.id)))
                .find(Boolean);

            if (!text) continue;

            // ST 把模型的一次回复拆成"正文"和"tool_calls"两条消息，
            // DeepSeek 认的是整条回合，所以推理挂在前面那条正文上（工具消息保持原样，不补）。
            const previous = messages[index - 1];
            if (isPlainAssistantMessage(previous)) {
                if (!hasReasoning(previous)) {
                    previous.reasoning_content = text;
                    patched += 1;
                }
                continue;
            }

            // 没有正文可挂（模型只回了工具调用）：退回挂在工具消息上，否则这段推理就丢了
            message.reasoning_content = text;
            patched += 1;
            continue;
        }

        // 普通 assistant 消息：ST 已经带了 reasoning（同源同模型时才有）
        if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
            message.reasoning_content = message.reasoning;
            patched += 1;
        }
    }

    return patched;
}

/**
 * 有正文、没有工具调用的 assistant 消息。
 * @param {any} message
 * @returns {boolean}
 */
function isPlainAssistantMessage(message) {
    if (!message || message.role !== 'assistant') return false;
    if (isToolCallMessage(message)) return false;
    return String(message.content ?? '').trim().length > 0;
}

/**
 * 找出仍然没有 reasoning_content 的 assistant 消息。
 * 用于在控制台指出"还差哪几条"，方便判断 400 到底卡在谁身上。
 * @param {any[]} messages
 * @returns {{index: number, hasToolCalls: boolean, preview: string}[]}
 */
export function findAssistantMessagesMissingReasoning(messages) {
    /** @type {{index: number, hasToolCalls: boolean, preview: string}[]} */
    const missing = [];
    if (!Array.isArray(messages)) return missing;

    messages.forEach((message, index) => {
        if (!message || message.role !== 'assistant' || hasReasoning(message)) return;
        missing.push({
            index,
            hasToolCalls: isToolCallMessage(message),
            preview: String(message.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
        });
    });

    return missing;
}

/**
 * @param {any} message
 * @returns {boolean}
 */
function isToolCallMessage(message) {
    return Boolean(message) && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

/**
 * @param {any} message
 * @returns {boolean}
 */
function hasReasoning(message) {
    return typeof message.reasoning_content === 'string' && message.reasoning_content.trim().length > 0;
}

/**
 * 安装补丁：包一层 ToolManager.registerFunctionToolsOpenAI。
 *
 * 这是每个请求组装完、发送前都会经过、且能拿到完整 generate_data 的公开入口
 * （它先于 custom_url 赋值执行，所以 URL 从 settings 里读）。
 *
 * @param {any} context getContext()（可以是 Proxy）
 * @returns {() => void} 卸载函数
 */
export function installReasoningBackfill(context) {
    const ToolManager = context?.ToolManager;
    if (!ToolManager || typeof ToolManager.registerFunctionToolsOpenAI !== 'function') {
        return () => { };
    }
    if (ToolManager.__scOriginalRegisterFunctionTools) {
        return () => { };
    }

    const original = ToolManager.registerFunctionToolsOpenAI;
    ToolManager.__scOriginalRegisterFunctionTools = original;

    ToolManager.registerFunctionToolsOpenAI = async function patchedRegisterFunctionToolsOpenAI(data) {
        const result = await original.call(this, data);
        try {
            if (needsReasoningBackfill(data, context?.chatCompletionSettings)) {
                const patched = applyReasoningBackfill(data, context?.chat);
                if (patched > 0) {
                    console.debug(`[scriptorium] 已回填 ${patched} 条消息的 reasoning_content`);
                }

                // 思考模式还开着却仍有普通 assistant 消息缺 reasoning_content：多半就是 400 的元凶
                if (data?.include_reasoning) {
                    const missing = findAssistantMessagesMissingReasoning(data.messages)
                        .filter(item => !item.hasToolCalls);
                    if (missing.length) {
                        console.warn(
                            `[scriptorium] 还有 ${missing.length} 条 assistant 消息没有 reasoning_content，若仍报 400 多半是它们：`,
                            missing,
                        );
                    }
                }
            }
        } catch (error) {
            console.warn('[scriptorium] reasoning_content 回填失败', error);
        }
        return result;
    };

    return () => {
        const restore = ToolManager.__scOriginalRegisterFunctionTools;
        if (restore) {
            ToolManager.registerFunctionToolsOpenAI = restore;
            delete ToolManager.__scOriginalRegisterFunctionTools;
        }
    };
}
