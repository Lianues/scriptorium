/**
 * Scriptorium —— 把当前聊天启用的世界书镜像成只读目录，给模型 read / grep。
 *
 * 另外把「世界书目录」作为一条虚拟常驻条目，插到预设里 World Info (before) 的最前面：
 * 模型开局就知道有哪些书和条目，不用先 list 再读；不改动任何世界书文件。
 *
 * 什么时候同步：
 *   - 换聊天 / 世界书内容或启用列表变化 → 防抖后重新镜像；
 *   - 每次生成前（manifest 的 generate_interceptor，早于世界书扫描）比对
 *     「聊天 + 启用的书 + 世界书改动次数」，变了就当场同步完再扫描。
 *     所以不需要手动 /scriptorium sync。
 *
 * 非常驻（非 🔵）条目一律不激活（关键词 / 向量都不触发），只留在镜像里给模型 read / grep。
 *
 * 启用时还会打开函数调用 / Active Tool Chain，并把 Tool Call Recurse Limit 设为 50（lib/tooling.js）。
 *
 * 关键点：不要在模块级缓存 getContext() 的返回值。酒馆切换聊天时会重新赋值
 * chat_metadata，缓存下来的对象会指向旧聊天，同步就会报「当前没有打开聊天」。
 * 这里用 Proxy，每次取属性都重新 getContext()。
 */

import { getContext } from '../../../extensions.js';
import { BOOK_ROOT, Scriptorium } from './lib/workspace.js';
import { registerWorkspaceTools, unregisterWorkspaceTools } from './lib/tools.js';
import {
    DIRECTORY_BOOK,
    appendDirectoryEntry,
    buildDirectoryContent,
    dropNonConstantEntries,
    removeLegacyDirectoryEntry,
} from './lib/directory.js';
import { ToolChainCollapse } from './lib/chain-collapse.js';
import { installReasoningBackfill } from './lib/reasoning-backfill.js';
import { ToolMessageActions } from './lib/message-actions.js';
import { installStyles } from './lib/styles.js';
import { applyToolingDefaults } from './lib/tooling.js';

const SYNC_DELAY = 600;
/** manifest.json 里 generate_interceptor 填的名字 */
const INTERCEPTOR_NAME = 'scriptoriumInterceptor';
const WAND_ID = 'sc_wand_button';

/** @type {any} */
let workspace = null;
/** @type {any} */
let syncTimer = null;
/** @type {Promise<void>|null} 正在跑的同步，避免两次 reset 交错 */
let syncing = null;
/** 插件被关掉后拦截器全局函数还在，用它短路 */
let enabled = false;
let hooksBound = false;
/** 世界书内容改动次数，进签名：内容变了就算启用列表没变也要重镜像 */
let revision = 0;
/** 上次成功同步时的「聊天 + 启用的书 + revision」 */
let syncedSignature = '';
/** 当前聊天的目录正文；每次世界书扫描时作为虚拟条目插进 World Info (before) */
let directoryContent = '';
/** @type {string} */
let lastReason = '';
/** @type {{books: number, names: string[], entries: number, files: number, at: number, chars: number}|null} */
let lastResult = null;
/** @type {string} */
let lastError = '';
/** @type {ToolChainCollapse|null} */
let chainCollapse = null;
/** @type {(() => void)|null} */
let uninstallReasoningBackfill = null;
/** @type {ToolMessageActions|null} */
let messageActions = null;
/** @type {any} */
let liveContext = null;

/**
 * 每次属性访问都重新取上下文。
 * @returns {ReturnType<typeof getContext>}
 */
function context() {
    if (!liveContext) {
        liveContext = new Proxy(/** @type {any} */ ({}), {
            get(_target, property) {
                return getContext()[property];
            },
            set(_target, property, value) {
                getContext()[property] = value;
                return true;
            },
            has(_target, property) {
                return property in getContext();
            },
            ownKeys() {
                return Reflect.ownKeys(getContext());
            },
            getOwnPropertyDescriptor(_target, property) {
                return {
                    value: getContext()[property],
                    writable: true,
                    enumerable: true,
                    configurable: true,
                };
            },
        });
    }
    return /** @type {ReturnType<typeof getContext>} */ (liveContext);
}

/**
 * manifest hooks.activate
 * @returns {Promise<void>}
 */
export async function init() {
    const ctx = context();
    enabled = true;

    installStyles();

    workspace = new Scriptorium(ctx);
    registerWorkspaceTools(ctx, workspace);

    // 工具链跑完后，把中间的工具调用消息折叠成一个胶囊
    chainCollapse?.destroy();
    chainCollapse = new ToolChainCollapse(ctx);
    chainCollapse.install();

    // 工具调用消息上补一个删除按钮（ST 把这些消息的按钮行整行隐藏了）
    messageActions?.destroy();
    messageActions = new ToolMessageActions(ctx);
    messageActions.install();

    // DeepSeek 思考模式：把工具调用那一轮的真实推理回填成 reasoning_content
    uninstallReasoningBackfill?.();
    uninstallReasoningBackfill = installReasoningBackfill(ctx);

    registerSlashCommand();
    bindHooks(ctx);
    enableTooling('init');
    ensureWandButton();

    // 旧版把目录写成了世界书条目，升级后摘掉（只跑一次）
    void removeLegacyDirectoryEntry(ctx)
        .then(removed => removed && console.info('[scriptorium] 已清理旧版写进世界书的目录条目'))
        .catch(error => console.warn('[scriptorium] 清理旧版目录条目失败', error));

    schedule('init');
}

/**
 * manifest hooks.enable
 * @returns {void}
 */
export function onEnable() {
    const ctx = context();
    enabled = true;
    if (workspace) registerWorkspaceTools(ctx, workspace);
    enableTooling('enable');
    ensureWandButton();
    schedule('enable');
}

/**
 * manifest hooks.disable
 * @returns {void}
 */
export function onDisable() {
    const ctx = context();
    enabled = false;

    unregisterWorkspaceTools(ctx);
    chainCollapse?.destroy();
    chainCollapse = null;
    uninstallReasoningBackfill?.();
    uninstallReasoningBackfill = null;
    messageActions?.destroy();
    messageActions = null;

    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    syncedSignature = '';
    directoryContent = '';

    document.getElementById(WAND_ID)?.closest('.extension_container')?.remove();
    document.getElementById(WAND_ID)?.remove();
}

/**
 * 挂事件：换聊天 / 世界书变动时重新镜像；世界书扫描时插入目录条目。
 * @param {any} ctx
 * @returns {void}
 */
function bindHooks(ctx) {
    if (hooksBound) return;
    hooksBound = true;

    const source = ctx.eventSource;
    const events = ctx.eventTypes ?? {};

    // 插件比魔法棒菜单先加载时，等界面就绪再补按钮
    source?.on?.(events.APP_READY, () => {
        if (enabled) ensureWandButton();
    });
    source?.on?.(events.CHAT_CHANGED, () => {
        if (!enabled) return;
        // 新聊天有自己的 sid，丢掉内存里上一个聊天的镜像；旧目录也先撤掉
        workspace?.reset();
        syncedSignature = '';
        directoryContent = '';
        schedule('chat-changed');
    });
    source?.on?.(events.WORLDINFO_UPDATED, () => {
        if (!enabled) return;
        revision += 1;
        schedule('worldinfo');
    });
    source?.on?.(events.WORLDINFO_SETTINGS_UPDATED, () => {
        if (enabled) schedule('worldinfo-settings');
    });
    // 每次扫描世界书（生成、提示词预览、向量同步都会）：
    //   1. 非常驻（非 🔵）条目剔出扫描 → 任何方式都不会激活，只能被 read / grep 读到；
    //   2. 插入目录条目，order 极低 → 排在 World Info (before) 开头。
    source?.on?.(events.WORLDINFO_ENTRIES_LOADED, (payload) => {
        if (!enabled) return;
        dropNonConstantEntries(payload);
        appendDirectoryEntry(payload, directoryContent);
    });
    // 函数调用等开关跟着 Chat Completion 预设走：设置加载完、切预设后都会被覆盖，再开一次
    source?.on?.(events.SETTINGS_LOADED_AFTER, () => {
        if (enabled) enableTooling('settings-loaded');
    });
    source?.on?.(events.OAI_PRESET_CHANGED_AFTER, () => {
        if (enabled) enableTooling('preset-changed');
    });
}

/**
 * 打开函数调用 / Active Tool Chain，并把 Tool Call Recurse Limit 设为 50。
 * @param {string} reason
 * @returns {void}
 */
function enableTooling(reason) {
    try {
        const result = applyToolingDefaults(context());
        console.info('[scriptorium] 工具调用设置已应用', reason, result);
    } catch (error) {
        console.warn('[scriptorium] 应用工具调用设置失败', error);
    }
}

/**
 * 合并短时间内的多次触发。
 * @param {string} reason
 * @returns {void}
 */
function schedule(reason) {
    if (!enabled) return;
    lastReason = reason;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        void sync();
    }, SYNC_DELAY);
}

/**
 * 当前聊天启用的书 + 用来判断要不要重镜像的签名。
 * @returns {Promise<{active: string[], signature: string}>}
 */
async function readState() {
    const ctx = context();
    const chatId = String(ctx.getCurrentChatId?.() ?? '');
    const active = (await workspace.activeBooks()).filter(name => name !== DIRECTORY_BOOK);
    return { active, signature: `${chatId}|${[...active].sort().join('\n')}|${revision}` };
}

/**
 * 生成前调用：状态变了（或从没成功过）就当场同步，保证目录条目是最新的。
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function ensureFresh(reason) {
    if (!enabled || !workspace?.isBound()) return;

    // 马上就要同步了，防抖里排着的那次不用再跑
    if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
    }
    if (syncing) await syncing;

    const { signature } = await readState();
    if (signature === syncedSignature) return;

    lastReason = reason;
    await sync();
}

/**
 * 串行执行：前一次还没跑完就等它，再按最新状态跑一次。
 * @returns {Promise<void>}
 */
async function sync() {
    while (syncing) await syncing;
    syncing = runSync().finally(() => {
        syncing = null;
    });
    return syncing;
}

/**
 * 重新镜像 + 重建目录正文。
 * @returns {Promise<void>}
 */
async function runSync() {
    const ctx = context();
    workspace = workspace ?? new Scriptorium(ctx);

    if (!workspace.isBound()) {
        lastError = '当前没有打开聊天';
        directoryContent = '';
        return;
    }

    try {
        await workspace.ready();
        await workspace.ensure();

        const { active, signature } = await readState();
        await workspace.importAll('reset', active);
        directoryContent = buildDirectoryContent(workspace.fs);

        syncedSignature = signature;
        lastResult = {
            books: active.length,
            names: [...active],
            entries: workspace.fs.files().filter(path => path.startsWith(`${BOOK_ROOT}/`)).length,
            files: workspace.stats().files,
            at: Date.now(),
            chars: directoryContent.length,
        };
        lastError = '';

        console.info('[scriptorium] 镜像完成', lastReason, lastResult);
    } catch (error) {
        lastError = error?.message ?? String(error);
        console.warn('[scriptorium] 同步失败', error);
    }
}

/**
 * manifest generate_interceptor：酒馆在拼提示词之前 await 它。
 * 只在这里补同步，绝不 abort 生成。
 * @param {any[]} _chat
 * @param {number} _contextSize
 * @param {(immediately: boolean) => void} _abort
 * @param {string} type
 * @returns {Promise<void>}
 */
async function generateInterceptor(_chat, _contextSize, _abort, type) {
    try {
        await ensureFresh(`generate:${type || 'normal'}`);
    } catch (error) {
        console.warn('[scriptorium] 生成前同步失败（不影响生成）', error);
    }
}

/**
 * /scriptorium：看一眼当前镜像状态；带 sync 立即重来一次。
 * @returns {void}
 */
function registerSlashCommand() {
    try {
        const ctx = context();
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'scriptorium',
            returns: 'void',
            helpString: '查看世界书镜像状态；带 sync 参数立即重新同步。',
            unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE
                ? [SlashCommandArgument.fromProps({
                    description: 'sync：立即重新同步',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                    enumList: ['sync'],
                })]
                : [],
            // 回调签名是 (命名参数, 无名参数)，sync 在第二个
            callback: async (_args, value) => {
                if (String(value ?? '').trim() === 'sync') {
                    await sync();
                }
                showStatus();
                return '';
            },
        }));
    } catch (error) {
        console.debug('[scriptorium] 注册 /scriptorium 失败（忽略）', error);
    }
}

/**
 * 弹一条提示：当前注入了哪些世界书。能弹出来本身就说明插件已加载。
 * @returns {void}
 */
function showStatus() {
    const toastr = globalThis.toastr;

    if (!workspace?.isBound()) {
        toastr?.info?.('已加载，当前没有打开聊天', 'Scriptorium');
        return;
    }
    if (lastError) {
        toastr?.error?.(`已加载，但同步失败：${lastError}`, 'Scriptorium', { timeOut: 12000 });
        return;
    }
    if (!lastResult) {
        toastr?.info?.('已加载，还没有同步过（等一会儿或执行 /scriptorium sync）', 'Scriptorium');
        return;
    }
    if (!lastResult.names.length) {
        toastr?.info?.('已加载，当前聊天没有启用世界书', 'Scriptorium');
        return;
    }

    toastr?.success?.(
        `已加载，注入 ${lastResult.books} 本世界书（${lastResult.entries} 个条目）：${lastResult.names.join('、')}`,
        'Scriptorium',
        { timeOut: 8000 },
    );
}

/**
 * 魔法棒菜单里的入口：点一下先补同步，再显示当前注入的世界书。
 * @returns {void}
 */
function ensureWandButton() {
    if (document.getElementById(WAND_ID)) return;

    const container = document.getElementById('extensionsMenu');
    if (!(container instanceof HTMLElement)) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'extension_container';

    const button = document.createElement('div');
    button.id = WAND_ID;
    button.className = 'list-group-item flex-container flexGap5';
    button.title = '显示当前注入的世界书';

    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-book-open extensionsMenuExtensionButton';

    const label = document.createElement('span');
    label.textContent = 'Scriptorium';

    button.append(icon, label);
    button.addEventListener('click', async () => {
        try {
            await ensureFresh('wand');
        } catch (error) {
            console.warn('[scriptorium] 同步失败', error);
        }
        showStatus();
    });

    wrapper.append(button);
    container.append(wrapper);
}

/** @type {any} */ (globalThis)[INTERCEPTOR_NAME] = generateInterceptor;

// 方便在控制台排查
globalThis.Scriptorium = {
    get workspace() {
        return workspace;
    },
    get lastResult() {
        return lastResult;
    },
    get lastError() {
        return lastError;
    },
    /** 当前插在 World Info (before) 开头的目录正文 */
    get directory() {
        return directoryContent;
    },
    sync: () => sync(),
};
