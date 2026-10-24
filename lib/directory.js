/**
 * 世界书目录：把 /world_book 的层级渲染成文本，作为一条「虚拟世界书条目」
 * 插到预设里 World Info (before) 的最前面。
 *
 * 目的：模型不用先 list 就能知道有哪些书、哪些条目，grep/read 直接传路径。
 *
 * 怎么插：酒馆每次扫描世界书前会发 WORLDINFO_ENTRIES_LOADED，把各来源的条目数组
 * 交给监听方。往 globalLore 里塞一条常驻条目（buildDirectoryEntry），它就和普通条目
 * 一样进入 World Info (before)；不写任何世界书文件。
 *
 * 同一个事件里还会把非常驻（非 🔵）条目从本次扫描里剔除（dropNonConstantEntries）：
 * 它们不再被关键词 / 向量等任何方式激活，只留在镜像里给模型 read / grep。
 *
 * 旧版本曾把目录真的写进世界书（第一本启用的书，或自建的 `Scriptorium` 书），
 * 升级后由 removeLegacyDirectoryEntry 摘掉。
 */

import { DIRECTORY_BOOK, DIRECTORY_COMMENT, DIRECTORY_ORDER, DIRECTORY_UID, DIRECTORY_WORLD } from './constants.js';
import { BOOK_ROOT } from './workspace.js';

export { DIRECTORY_BOOK, DIRECTORY_COMMENT, DIRECTORY_WORLD };

const MAX_LISTING_LINES = 1200;
const MAX_CONTENT_CHARS = 20_000;

const CONSTANT_MARK = '[常驻]';

/**
 * 把 fs 里的目录渲染成「完整目录路径 + 缩进文件名」，模型拼路径时不用自己数树枝。
 * 常驻条目（会被自动注入上下文）在文件名后标 [常驻]：
 *
 *   /world_book/书/
 *     0_标题.md  [常驻]
 *     1_标题.md
 *
 * @param {any} fs
 * @param {string} [root]
 * @returns {{lines: string[], files: number, books: number, firstFile: string, truncated: boolean}}
 *          firstFile 优先取非常驻条目（真正需要 read 的那种），用作示例路径
 */
export function buildListing(fs, root = BOOK_ROOT) {
    /** @type {string[]} */
    const lines = [];
    let files = 0;
    let firstFile = '';
    let firstConstant = '';
    let truncated = false;

    if (!fs.exists(root) || !fs.isDir(root)) {
        return { lines, files, books: 0, firstFile, truncated };
    }

    const walk = (path) => {
        const items = fs.list(path);
        const leaves = items.filter(item => !item.dir);

        if (leaves.length) {
            lines.push(`${path}/`);
            for (const item of leaves) {
                if (lines.length >= MAX_LISTING_LINES) {
                    truncated = true;
                    return;
                }
                const constant = fs.stat(item.path)?.origin?.constant === true;
                lines.push(constant ? `  ${item.name}  ${CONSTANT_MARK}` : `  ${item.name}`);
                files += 1;
                if (constant) firstConstant ||= item.path;
                else firstFile ||= item.path;
            }
        }

        for (const item of items.filter(entry => entry.dir)) {
            if (truncated) return;
            walk(item.path);
        }
    };

    const books = fs.list(root).filter(item => item.dir).length;
    walk(root);

    return { lines, files, books, firstFile: firstFile || firstConstant, truncated };
}

/**
 * 生成目录正文。
 *
 * @param {any} fs
 * @returns {string}
 */
export function buildDirectoryContent(fs) {
    const listing = buildListing(fs);

    if (!listing.books) {
        return [
            '[世界书目录]',
            '当前聊天没有启用任何世界书，镜像目录为空，read / grep 查不到任何条目。',
            '这就是最终状态，不需要再用 read 确认。',
        ].join('\n');
    }

    const example = listing.firstFile || `${BOOK_ROOT}/<世界书名>/<uid>_<标题>.md`;

    /** @type {string[]} */
    const lines = [
        '[世界书目录]',
        '当前聊天启用的世界书已镜像为只读文件。下面就是完整、最新的目录：每次请求前自动生成，与实际文件完全一致。',
        '不要用 read 列目录或再核对结构；需要条目内容时直接 read 下面的文件路径，不确定在哪条里时用 grep 搜关键词。',
        '每个 .md 文件就是一条启用中的条目正文，文件名为 <uid>_<标题>.md；被禁用的条目不在其中。',
        `标 ${CONSTANT_MARK} 的条目正文已经自动放进上下文，一般不用再读；其余条目不会被自动注入（关键词也不会触发），只能用 read / grep 获取。`,
        '',
        `共 ${listing.books} 本世界书、${listing.files} 个条目：`,
        '```',
        ...listing.lines,
        '```',
    ];

    if (listing.truncated) {
        lines.push('（目录太长，只列了前一部分；其余请用 grep 搜索，或 read 对应的书目录。）');
    }

    lines.push(
        '',
        '示例：',
        `- read {"path": "${example}"}`,
        '- grep {"args": "关键词 -i -C 1"}',
    );

    const content = lines.join('\n');
    return content.length > MAX_CONTENT_CHARS
        ? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n（内容超长已截断）`
        : content;
}

/**
 * 虚拟目录条目：字段对齐酒馆的 newWorldInfoEntryTemplate，扫描逻辑会逐个读这些字段。
 *
 *  - constant + position 0（before）：每次都激活，进 World Info (before)；
 *  - order 极低：排在 World Info (before) 最前面；
 *  - ignoreBudget：不占世界书 token 预算，预算爆了也不会被挤掉；
 *  - preventRecursion / excludeRecursion：目录里全是条目名，不能让它递归触发别的关键词条目。
 *
 * @param {string} content
 * @returns {Record<string, any>}
 */
export function buildDirectoryEntry(content) {
    return {
        uid: DIRECTORY_UID,
        world: DIRECTORY_WORLD,
        key: [],
        keysecondary: [],
        comment: DIRECTORY_COMMENT,
        content,
        constant: true,
        vectorized: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: false,
        order: DIRECTORY_ORDER,
        position: 0,
        disable: false,
        ignoreBudget: true,
        excludeRecursion: true,
        preventRecursion: true,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: false,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        characterFilter: { isExclude: false, names: [], tags: [] },
    };
}

/**
 * WORLDINFO_ENTRIES_LOADED 的处理：把目录条目塞进本次扫描的全局条目。
 * globalLore 是酒馆每次扫描新建的数组，push 不会污染缓存。
 *
 * @param {{globalLore?: any[]}|undefined} payload
 * @param {string} content 目录正文；空串表示不插
 * @returns {boolean} 是否插入
 */
export function appendDirectoryEntry(payload, content) {
    const lore = payload?.globalLore;
    if (!content || !Array.isArray(lore)) return false;
    if (lore.some(entry => entry?.world === DIRECTORY_WORLD && entry?.uid === DIRECTORY_UID)) return false;
    lore.push(buildDirectoryEntry(content));
    return true;
}

/**
 * WORLDINFO_ENTRIES_LOADED 的处理：把非常驻条目从本次扫描里剔除。
 *
 * 扫描列表里没有它们，关键词、向量、强制激活、@@activate、sticky 统统无从触发；
 * 世界书文件本身不动，镜像里也照常保留，模型仍能 read / grep 到正文。
 * 数组要原地改：酒馆在事件之后才用这几个数组拼扫描列表。
 *
 * @param {{globalLore?: any[], characterLore?: any[], chatLore?: any[], personaLore?: any[]}|undefined} payload
 * @returns {number} 剔除的条目数
 */
export function dropNonConstantEntries(payload) {
    let dropped = 0;
    for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
        const lore = payload?.[key];
        if (!Array.isArray(lore)) continue;

        const kept = lore.filter(entry => entry?.constant === true);
        dropped += lore.length - kept.length;
        if (kept.length !== lore.length) lore.splice(0, lore.length, ...kept);
    }
    return dropped;
}

/**
 * 升级清理：摘掉旧版写进世界书的目录条目，并取消启用自建目录书。
 * 只在设置里还留着旧版记录的位置时才动手，清完就把记录删掉，所以只跑一次。
 *
 * @param {any} context
 * @returns {Promise<boolean>} 是否做了清理
 */
export async function removeLegacyDirectoryEntry(context) {
    const location = readLocation(context);
    if (!location) return false;

    for (const book of new Set([DIRECTORY_BOOK, location.book])) {
        await removeMarker(context, book);
    }

    writeLocation(context, null);
    await deactivateBook(context, DIRECTORY_BOOK);
    return true;
}

/**
 * @param {Record<string, any>} entries
 * @returns {{uid: number, entry: any}|null}
 */
function findMarker(entries) {
    for (const [key, entry] of Object.entries(entries)) {
        if (entry?.comment !== DIRECTORY_COMMENT) continue;
        const uid = Number.isInteger(entry.uid) ? entry.uid : Number(key);
        if (!Number.isInteger(uid)) continue;
        return { uid, entry };
    }
    return null;
}

/**
 * 从指定世界书里删掉标记条目。
 * @param {any} context
 * @param {string} book
 * @returns {Promise<void>}
 */
async function removeMarker(context, book) {
    let previous;
    try {
        previous = await context?.loadWorldInfo?.(book);
    } catch {
        return;
    }

    const entries = { ...(previous?.entries ?? {}) };
    const marker = findMarker(entries);
    if (!marker) return;

    delete entries[marker.uid];
    await context?.saveWorldInfo?.(book, { ...previous, entries }, true);
}

/**
 * 旧版记录的「目录条目写在哪个世界书、哪个 uid」。
 * @param {any} context
 * @returns {{book: string, uid: number}|null}
 */
function readLocation(context) {
    const value = context?.extensionSettings?.scriptorium?.directoryLocation;
    if (!value || typeof value.book !== 'string') return null;
    return { book: value.book, uid: Number.isInteger(value.uid) ? value.uid : 0 };
}

/**
 * @param {any} context
 * @param {{book: string, uid: number}|null} value
 * @returns {void}
 */
function writeLocation(context, value) {
    const settings = context?.extensionSettings?.scriptorium;
    if (!settings) return;

    if (value) settings.directoryLocation = value;
    else delete settings.directoryLocation;

    context.saveSettingsDebounced?.();
}

/**
 * 从启用列表里摘掉一本书：运行时数组、设置、DOM 里的 option 三处都要改，
 * 否则用户一操作世界书面板，酒馆会从 DOM 重新算回来。
 *
 * @param {any} context
 * @param {string} name
 * @returns {Promise<void>}
 */
async function deactivateBook(context, name) {
    const worldInfo = context?.powerUserSettings?.world_info;
    if (worldInfo && Array.isArray(worldInfo.globalSelect)) {
        const index = worldInfo.globalSelect.indexOf(name);
        if (index >= 0) worldInfo.globalSelect.splice(index, 1);
        context.saveSettingsDebounced?.();
    }

    try {
        const module = await import('../../../../world-info.js');
        const live = module?.selected_world_info;
        if (Array.isArray(live)) {
            const index = live.indexOf(name);
            if (index >= 0) live.splice(index, 1);
        }
    } catch {
        // 忽略
    }

    try {
        const select = document.getElementById('world_info');
        if (select instanceof HTMLSelectElement) {
            const option = [...select.options].find(item => item.textContent?.trim() === name);
            if (option) option.selected = false;
        }
    } catch {
        // 忽略
    }
}
