/**
 * Scriptorium：当前聊天「启用的世界书」的只读镜像。
 *
 * 存储分两层：
 *   chat_metadata.scriptorium = { v, sid, owner, books }   ← 指针（几十字节）
 *   IndexedDB  "vfs:<sid>"      = { version, nodes, books }  ← 文件正文
 *
 *  - 只读：没有任何写回酒馆的路径，模型只能 read / grep；
 *  - 被禁用的世界书条目不会导入；
 *  - IndexedDB 打不开时退化为「正文写进 chat_metadata」。
 *
 * 目录骨架（只放正文，不导出条目配置）：
 *   /world_book/<世界书名>/<uid>_<标题>.md
 *   /README.md
 */

import { WorkspaceFS } from './vfs.js';
import { entryBaseName, safeSegment } from './wb-map.js';
import { WorkspaceStorage } from './storage.js';
import { DIRECTORY_COMMENT } from './constants.js';

export const META_KEY = 'scriptorium';
export const SCHEMA_VERSION = 2;

export const BOOK_ROOT = '/world_book';
export const README_PATH = '/README.md';

const FLUSH_DELAY = 400;

const README_TEXT = `# Scriptorium

这里的文件是**当前聊天启用的世界书**的只读镜像，供 \`read\` / \`grep\` 检索。
正文存在浏览器 IndexedDB 里，聊天文件里只留一个指针。

## 目录

- \`/world_book/<世界书名>/<uid>_<标题>.md\` —— 一个文件就是一条启用中的条目正文。

## 可用工具

- \`read\`：读文件；传目录返回目录列表；\`startLine\`/\`endLine\` 按行切。
- \`grep\`：rg 风格搜索，例如 \`千束 -i -C 1 /world_book\`。

被禁用的世界书条目不会出现在这里。
`;


/**
 * @returns {string}
 */
function randomId() {
    const cryptoObject = /** @type {any} */ (globalThis).crypto;
    if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
    return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @returns {Record<string, any>}
 */
function blankWorkspace() {
    return { version: SCHEMA_VERSION, nodes: { '/': { t: 'd' } }, books: {} };
}

export class Scriptorium {
    /**
     * @param {any} context getContext() 的返回值（可以是 Proxy，每次取值都拿最新聊天）
     * @param {{storage?: WorkspaceStorage|null, idFactory?: () => string}} [options]
     *        storage 显式传 null 可强制走 chat_metadata 回退（便于测试）
     */
    constructor(context, options = {}) {
        this.context = context;
        this.storage = Object.hasOwn(options, 'storage') ? (options.storage ?? null) : undefined;
        this.idFactory = options.idFactory ?? randomId;

        /** @type {Record<string, any>|null} */
        this.store = null;
        this.sid = '';
        this.owner = '';
        this.cloned = false;
        /** IndexedDB 里的记录丢失、已改用新 sid（避免覆盖旧数据） */
        this.lost = false;
        /** @type {Promise<any>|null} */
        this.loading = null;
        /** @type {any} */
        this.flushTimer = null;
        /** @type {Set<(reason: string) => void>} */
        this.listeners = new Set();
    }

    /**
     * 当前是否有可用的聊天作用域。
     * @returns {boolean}
     */
    isBound() {
        try {
            return Boolean(this.context?.getCurrentChatId?.() || this.context?.chatId);
        } catch {
            return false;
        }
    }

    /**
     * 工作区是否已加载完成。
     * @returns {boolean}
     */
    isReady() {
        return Boolean(this.store);
    }

    /**
     * 加载（或创建）当前聊天的工作区。
     * @returns {Promise<Record<string, any>>}
     */
    async ready() {
        if (this.store) return this.store;
        if (!this.loading) {
            this.loading = this.#load().catch(error => {
                this.loading = null;
                throw error;
            });
        }
        return this.loading;
    }

    /**
     * 切换到别的聊天时丢弃内存状态。
     * @returns {void}
     */
    reset() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.store = null;
        this.sid = '';
        this.owner = '';
        this.cloned = false;
        this.lost = false;
        this.loading = null;
    }

    /**
     * 虚拟文件系统句柄（每次新建包装器，底层 nodes 共享引用）。
     * @returns {WorkspaceFS}
     */
    get fs() {
        if (!this.store) throw new Error('工作区尚未加载，请先 await ready()');
        return new WorkspaceFS(this.store);
    }

    /**
     * @param {(reason: string) => void} listener
     * @returns {() => void} 取消订阅
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * 记录变更：更新指针、排一次落盘、通知 UI。
     * @param {string} reason
     * @param {{path?: string}} [detail] 变更的文件路径（自动写回要靠它定位世界书）
     * @returns {void}
     */
    touch(reason = 'change', detail = undefined) {
        this.#writeRef();
        if (this.storage) this.#scheduleFlush();
        for (const listener of this.listeners) {
            try {
                listener(reason, detail);
            } catch (error) {
                console.error('[scriptorium] listener 失败', error);
            }
        }
    }

    /**
     * 立即把正文写进 IndexedDB。
     * @returns {Promise<void>}
     */
    async flush() {
        if (!this.storage || !this.store) return;
        const sid = this.sid;
        const payload = {
            version: this.store.version ?? SCHEMA_VERSION,
            nodes: this.store.nodes,
            books: this.store.books,
        };
        try {
            await this.storage.write(sid, payload);
        } catch (error) {
            console.warn('[scriptorium] 写入 IndexedDB 失败，退回聊天元数据存储', error);
            this.storage = null;
            this.#writeRef();
        }
    }

    /**
     * 建立骨架（幂等，不覆盖已有内容）。
     * @returns {Promise<boolean>} 是否有改动
     */
    async ensure() {
        await this.ready();
        const fs = this.fs;
        let changed = false;

        for (const dir of [BOOK_ROOT]) {
            if (!fs.exists(dir)) {
                fs.mkdirp(dir);
                changed = true;
            }
        }
        // 旧镜像里的 README 可能还是老布局的说明，内容不一致就覆盖
        if (!fs.exists(README_PATH) || fs.read(README_PATH) !== README_TEXT) {
            fs.write(README_PATH, README_TEXT, { kind: 'readme' });
            changed = true;
        }

        if (changed) this.touch('ensure');
        return changed;
    }

    /**
     * 当前聊天「启用」的世界书名称。
     * 覆盖：聊天绑定 / 角色绑定 / 全局多选（World Info 面板）。
     * @returns {Promise<string[]>}
     */
    async activeBooks() {
        const ctx = this.context;
        /** @type {Set<string>} */
        const names = new Set();

        const add = (value) => {
            if (typeof value === 'string' && value.trim()) names.add(value.trim());
        };

        add(ctx?.chatMetadata?.world_info);

        const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
        const character = Number.isInteger(ctx?.characterId) ? characters[ctx.characterId] : null;
        add(character?.data?.extensions?.world);

        for (const name of await readGlobalSelection(ctx)) add(name);

        const known = new Set(ctx?.getWorldInfoNames?.() ?? []);
        return [...names].filter(name => (known.size ? known.has(name) : true));
    }

    /**
     * 取（或创建）某个世界书对应的目录。
     * @param {string} bookName
     * @returns {string}
     */
    ensureBookDir(bookName) {
        const root = this.store;
        if (!root) throw new Error('工作区尚未加载');
        const books = root.books;

        const existing = Object.entries(books).find(([, name]) => name === bookName);
        if (existing) {
            this.fs.mkdirp(existing[0]);
            return existing[0];
        }

        const base = `${BOOK_ROOT}/${safeSegment(bookName) || 'world_book'}`;
        let dir = base;
        let index = 2;
        while (books[dir] && books[dir] !== bookName) {
            dir = `${base} (${index})`;
            index += 1;
        }
        books[dir] = bookName;
        this.fs.mkdirp(dir);
        return dir;
    }

    /**
     * 从酒馆世界书导入到工作区：每个启用的条目一个 <uid>_<标题>.md，只有正文。
     * @param {string} bookName
     * @param {'fill'|'reset'} [mode] fill=只补缺失文件；reset=清空重建
     * @returns {Promise<{book: string, dir: string, created: number, skipped: number, disabled: number, total: number}>}
     */
    async importBook(bookName, mode = 'fill') {
        if (typeof bookName !== 'string' || !bookName.trim()) throw new Error('世界书名称无效');
        await this.ready();

        const fs = this.fs;
        const dir = this.ensureBookDir(bookName);

        if (mode === 'reset') {
            fs.remove(dir);
            fs.mkdirp(dir);
        }

        const data = await this.context?.loadWorldInfo?.(bookName);
        if (!data || typeof data.entries !== 'object' || data.entries === null) {
            throw new Error(`读不到世界书 "${bookName}" 的条目`);
        }

        let created = 0;
        let skipped = 0;
        let disabled = 0;
        let total = 0;

        for (const [key, entry] of Object.entries(data.entries)) {
            if (!entry || typeof entry !== 'object') continue;
            const uid = Number.isInteger(entry.uid) ? entry.uid : Number(key);
            if (!Number.isInteger(uid)) continue;
            total += 1;

            // 关掉的条目根本不进镜像：grep/read 不该看到模型「看不到」的内容
            if (entry.disable === true) {
                disabled += 1;
                continue;
            }

            // 旧版写进世界书的目录条目也不进镜像，否则目录里会套一份自己
            if (entry.comment === DIRECTORY_COMMENT) continue;

            const path = `${dir}/${entryBaseName(uid, entry.comment)}.md`;
            if (fs.exists(path)) {
                skipped += 1;
                continue;
            }
            // constant 记进来源：目录里要标出哪些条目会被自动注入（其余的只能靠 read / grep）
            fs.write(path, String(entry.content ?? ''), { kind: 'book-entry', book: bookName, uid, constant: entry.constant === true });
            created += 1;
        }

        this.touch('import');
        return { book: bookName, dir, created, skipped, disabled, total };
    }

    /**
     * 把所有启用的世界书都导入一遍。
     *
     * @param {'fill'|'reset'} [mode] reset 会先清空 world_book/ 再重建
     * @param {string[]|null} [names] 指定要导入的书名；不传就用当前聊天启用的那些
     * @returns {Promise<{book: string, dir: string, created: number, skipped: number, disabled: number, total: number}[]>}
     */
    async importAll(mode = 'fill', names = null) {
        await this.ready();

        if (mode === 'reset') {
            const fs = this.fs;
            for (const item of fs.list(BOOK_ROOT)) {
                fs.remove(item.path);
            }
            this.store.books = {};
        }

        const books = Array.isArray(names) ? names : await this.activeBooks();

        const results = [];
        for (const book of books) {
            results.push(await this.importBook(book, mode));
        }
        return results;
    }

    /**
     * 把已经不在「启用列表」里的世界书目录移除。
     *
     * 只负责执行；要不要删（比如世界书列表还没加载好时）由调用方判断。
     *
     * @param {string[]} activeBooks 当前仍启用的世界书
     * @returns {Promise<{dir: string, book: string}[]>} 被移除的目录
     */
    async removeInactiveBooks(activeBooks) {
        await this.ready();

        const active = new Set(activeBooks ?? []);
        const removed = [];

        for (const item of this.bookDirs()) {
            if (active.has(item.book)) continue;
            this.fs.remove(item.dir);
            delete this.store.books[item.dir];
            removed.push(item);
        }

        if (removed.length) this.touch('remove-inactive');
        return removed;
    }

    /**
     * 已导入的世界书目录映射。
     * @returns {{dir: string, book: string}[]}
     */
    bookDirs() {
        if (!this.store) return [];
        return this.fs.list(BOOK_ROOT)
            .filter(item => item.dir)
            .map(item => ({ dir: item.path, book: this.store.books[item.path] ?? item.name }));
    }

    /**
     * @returns {{files: number, dirs: number, bytes: number, text: string}}
     */
    stats() {
        if (!this.store) return { files: 0, dirs: 0, bytes: 0, text: '0 文件 / 0 目录 / 0 B' };
        return this.fs.stats();
    }

    // -----------------------------------------------------------------------
    // 内部
    // -----------------------------------------------------------------------

    /**
     * @returns {Promise<Record<string, any>>}
     */
    async #load() {
        const ctx = this.context;
        const metadata = ctx?.chatMetadata;
        if (!metadata || typeof metadata !== 'object') {
            throw new Error('当前没有打开聊天，工作区不可用');
        }

        const chatId = String(ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? '');

        if (this.storage === undefined) {
            try {
                this.storage = await WorkspaceStorage.create();
            } catch {
                this.storage = null;
            }
        }

        const ref = metadata[META_KEY] && typeof metadata[META_KEY] === 'object' ? metadata[META_KEY] : null;

        let previousSid = typeof ref?.sid === 'string' ? ref.sid : '';
        let data = previousSid && this.storage ? await this.storage.read(previousSid) : null;

        // 没有 IndexedDB（private 模式 / 浏览器不给配额）时的降级：正文就存在 chat_metadata 里
        if (!data && !this.storage && ref?.nodes && typeof ref.nodes === 'object') {
            data = { version: SCHEMA_VERSION, nodes: ref.nodes, books: ref.books ?? {} };
        }

        let sid = previousSid;
        let cloned = false;
        let lost = false;

        if (!data) {
            data = blankWorkspace();
            if (!sid) {
                sid = this.idFactory();
            } else if (this.storage) {
                // 指针还在、记录读不到（清过站点数据 / 换了浏览器）：
                // 换一个新 sid，绝不覆盖原记录，旧数据仍留在 IndexedDB 里
                lost = true;
                sid = this.idFactory();
            }
        } else if (ref?.owner && chatId && ref.owner !== chatId) {
            // 聊天被分支 / 改名：内容复制一份，避免两个聊天共享同一块数据
            data = {
                version: SCHEMA_VERSION,
                nodes: structuredClone(data.nodes ?? {}),
                books: { ...(data.books ?? {}) },
            };
            sid = this.idFactory();
            cloned = true;
        }

        data.version ??= SCHEMA_VERSION;
        data.nodes ??= { '/': { t: 'd' } };
        data.books ??= {};

        this.store = data;
        this.sid = sid;
        this.owner = chatId;
        this.cloned = cloned;
        this.lost = lost;
        this.#writeRef();

        if (this.storage && (cloned || lost || sid !== previousSid)) {
            try {
                await this.storage.write(sid, data);
            } catch (error) {
                console.warn('[scriptorium] 初始化写入 IndexedDB 失败', error);
                this.storage = null;
                this.#writeRef();
            }
        }

        return data;
    }

    /**
     * 把指针写回聊天元数据。
     * @returns {void}
     */
    #writeRef() {
        const metadata = this.context?.chatMetadata;
        if (!metadata || !this.store) return;

        /** @type {Record<string, any>} */
        const ref = {
            v: SCHEMA_VERSION,
            sid: this.sid,
            owner: this.owner,
            books: this.store.books,
            storage: this.storage ? 'idb' : 'chat',
        };
        if (!this.storage) {
            // 兜底：IndexedDB 不可用时，正文仍写进元数据
            ref.nodes = this.store.nodes;
        }

        metadata[META_KEY] = ref;
        try {
            this.context?.saveMetadataDebounced?.();
        } catch (error) {
            console.error('[scriptorium] 保存聊天元数据失败', error);
        }
    }

    /**
     * @returns {void}
     */
    #scheduleFlush() {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, FLUSH_DELAY);
    }
}

/**
 * 全局 World Info 多选里勾选的条目。
 * 优先读 world-info.js 的实时 export，退化为读 UI 上的多选框。
 * @param {any} context
 * @returns {Promise<string[]>}
 */
async function readGlobalSelection(context) {
    try {
        const module = await import('../../../../world-info.js');
        if (Array.isArray(module.selected_world_info)) {
            return [...module.selected_world_info];
        }
    } catch {
        // 忽略：某些版本 / 测试环境拿不到内部 export
    }

    const fromSettings = context?.powerUserSettings?.world_info?.globalSelect;
    if (Array.isArray(fromSettings)) return [...fromSettings];

    try {
        const select = document.getElementById('world_info');
        if (select instanceof HTMLSelectElement) {
            return [...select.selectedOptions].map(option => option.value);
        }
    } catch {
        // 忽略
    }

    return [];
}
