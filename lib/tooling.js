/**
 * 插件启用时把酒馆的工具调用相关设置打开：
 *   - 启用函数调用（#openai_function_calling）—— 不开的话 read / grep 根本发不出去；
 *   - Interleaved Thinking 选「Active Tool Chain」（#tool_reasoning_mode，新版才有）；
 *   - Tool Call Recurse Limit 拉到 50（#tool_call_recurse_limit，滑块上限就是 50）。
 *
 * 优先改界面控件再派发 input：走酒馆自己的处理器，它会写 oai_settings、更新
 * ToolManager.RECURSE_LIMIT 并保存。控件不在（界面没渲染 / 版本不同）时直接写设置兜底。
 *
 * 这些都跟着 Chat Completion 预设走，切预设会被覆盖，所以调用方在切预设后要再调一次。
 */

const RECURSE_LIMIT = 50;
const ACTIVE_CHAIN = 'active_chain';

/**
 * @param {any} context getContext()
 * @returns {{functionCalling: boolean, activeChain: boolean|null, recurseLimit: number}}
 *          activeChain 为 null 表示这个版本没有该选项
 */
export function applyToolingDefaults(context) {
    const settings = context?.chatCompletionSettings;
    let changed = false;

    // 启用函数调用
    const functionCalling = document.getElementById('openai_function_calling');
    if (functionCalling instanceof HTMLInputElement) {
        if (!functionCalling.checked) {
            functionCalling.checked = true;
            functionCalling.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    if (settings && settings.function_calling !== true) {
        settings.function_calling = true;
        changed = true;
    }

    // Interleaved Thinking → Active Tool Chain（老版本没有这个下拉框 / 选项就跳过）
    let activeChain = null;
    const reasoningMode = document.getElementById('tool_reasoning_mode');
    if (reasoningMode instanceof HTMLSelectElement && [...reasoningMode.options].some(option => option.value === ACTIVE_CHAIN)) {
        if (reasoningMode.value !== ACTIVE_CHAIN) {
            reasoningMode.value = ACTIVE_CHAIN;
            reasoningMode.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (settings && settings.tool_reasoning_mode !== ACTIVE_CHAIN) {
            settings.tool_reasoning_mode = ACTIVE_CHAIN;
            changed = true;
        }
        activeChain = true;
    }

    // Tool Call Recurse Limit
    const recurse = document.getElementById('tool_call_recurse_limit');
    if (recurse instanceof HTMLInputElement) {
        if (Number(recurse.value) !== RECURSE_LIMIT) {
            recurse.value = String(RECURSE_LIMIT);
            recurse.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    if (settings && settings.tool_call_recurse_limit !== RECURSE_LIMIT) {
        settings.tool_call_recurse_limit = RECURSE_LIMIT;
        changed = true;
    }
    const counter = document.getElementById('tool_call_recurse_limit_counter');
    if (counter instanceof HTMLInputElement && Number(counter.value) !== RECURSE_LIMIT) {
        counter.value = String(RECURSE_LIMIT);
    }
    if (context?.ToolManager && context.ToolManager.RECURSE_LIMIT !== RECURSE_LIMIT) {
        context.ToolManager.RECURSE_LIMIT = RECURSE_LIMIT;
    }

    // 控件处理器已经保存过的话这里是空操作；兜底路径靠它落盘
    if (changed) context?.saveSettingsDebounced?.();

    return {
        functionCalling: settings?.function_calling === true,
        activeChain,
        recurseLimit: Number(settings?.tool_call_recurse_limit ?? context?.ToolManager?.RECURSE_LIMIT ?? 0),
    };
}
