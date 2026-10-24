/**
 * 工作区文件正文的持久化层：IndexedDB（localforage）。
 *
 * 为什么不塞进 chat_metadata：
 *  - 酒馆每条消息都会重写整个 chat 文件，工作区里放几十上百个世界书条目 + 以后的历史记录，
 *    会把存档拖到几 MB 并放大每次保存的写入量；
 *  - IndexedDB 只写一条记录，且不参与 chat 文件的读写。
 *
 * chat_metadata 里只留一个几十字节的指针（sid / owner / books），
 * 这样既知道这份数据属于哪个聊天，也不会把正文写进存档。
 *
 * 任何一步失败（隐私模式、浏览器禁用 IDB、localforage 缺失）都返回 null，
 * 由上层退回到「整包写进 chat_metadata」的老路，保证插件仍可用。
 */

const DB_NAME = 'SillyTavern';
const STORE_NAME = 'scriptorium';

/**
 * @returns {Promise<any|null>} localforage 实例或 null
 */
async function resolveLocalforage() {
    const globalLf = /** @type {any} */ (globalThis).localforage;
    if (globalLf?.createInstance) return globalLf;

    try {
        const module = await import('../../../../../lib.js');
        const lf = module?.localforage ?? module?.default?.localforage;
        if (lf?.createInstance) return lf;
    } catch {
        // lib.js 不可用（例如本地单测环境）
    }

    return null;
}

/**
 * @param {string} sid
 * @returns {string}
 */
function keyOf(sid) {
    return `vfs:${sid}`;
}

export class WorkspaceStorage {
    /**
     * @param {any} instance localforage 实例
     */
    constructor(instance) {
        this.instance = instance;
    }

    /**
     * 尝试打开 IndexedDB。不可用时返回 null。
     * @returns {Promise<WorkspaceStorage|null>}
     */
    static async create() {
        const lf = await resolveLocalforage();
        if (!lf) return null;

        try {
            const instance = lf.createInstance({ name: DB_NAME, storeName: STORE_NAME });
            if (typeof instance.ready === 'function') await instance.ready();
            return new WorkspaceStorage(instance);
        } catch (error) {
            console.warn('[scriptorium] IndexedDB 不可用，退回聊天元数据存储', error);
            return null;
        }
    }

    /**
     * @param {string} sid
     * @returns {Promise<{version: number, nodes: Record<string, any>, books: Record<string, string>}|null>}
     */
    async read(sid) {
        if (!sid) return null;
        try {
            const value = await this.instance.getItem(keyOf(sid));
            if (!value || typeof value !== 'object' || !value.nodes) return null;
            return value;
        } catch (error) {
            console.warn(`[scriptorium] 读取工作区 ${sid} 失败`, error);
            return null;
        }
    }

    /**
     * @param {string} sid
     * @param {{version: number, nodes: Record<string, any>, books: Record<string, string>}} payload
     * @returns {Promise<void>}
     */
    async write(sid, payload) {
        if (!sid) throw new Error('sid 为空');
        await this.instance.setItem(keyOf(sid), payload);
    }

    /**
     * @param {string} sid
     * @returns {Promise<void>}
     */
    async remove(sid) {
        if (!sid) return;
        await this.instance.removeItem(keyOf(sid));
    }
}
