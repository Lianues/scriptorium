/**
 * 工作区虚拟文件系统。
 *
 * 没有任何 IO：数据就是从聊天元数据里取出来的一个普通对象，直接原地修改，
 * 所以写入即持久化（由上层负责 saveMetadata）。
 *
 * 存储结构（可直接 JSON 序列化）：
 * {
 *   nodes: {
 *     "/":            { t: "d" },
 *     "/world_book":  { t: "d" },
 *     "/README.md":   { t: "f", c: "...", m: 1712345678901, o: { kind: "user" } }
 *   }
 * }
 *
 * `o` 是来源标记，用来把文件映射回世界书条目：
 *   { kind: "book-meta",  book: "莉可丽丝" }
 *   { kind: "book-entry", book: "莉可丽丝", uid: 3, part: "yaml" | "md" }
 *   { kind: "user" }
 */

export const KIND_DIR = 'd';
export const KIND_FILE = 'f';

/**
 * 归一化工作区路径：`/` 开头、`/` 分隔、无 `.` / `..` / 重复分隔符。
 * @param {string} input
 * @returns {string}
 */
export function normalizePath(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('path 不能为空');
    }
    let text = input.trim().replace(/\\/g, '/');
    if (!text.startsWith('/')) text = `/${text}`;

    /** @type {string[]} */
    const segments = [];
    for (const segment of text.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            segments.pop();
            continue;
        }
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(segment)) {
            throw new Error(`path 含控制字符: ${JSON.stringify(segment)}`);
        }
        segments.push(segment);
    }
    return `/${segments.join('/')}`;
}

/**
 * @param {string} path 已归一化的路径
 * @returns {string}
 */
export function parentOf(path) {
    if (path === '/') return '/';
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
}

/**
 * @param {string} path 已归一化的路径
 * @returns {string}
 */
export function baseName(path) {
    if (path === '/') return '/';
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * UTF-8 字节数。
 * @param {string} text
 * @returns {number}
 */
export function byteLength(text) {
    return new TextEncoder().encode(text).length;
}

export class WorkspaceFS {
    /**
     * @param {{nodes: Record<string, any>}} store 与聊天元数据共享引用的存储对象
     */
    constructor(store) {
        this.store = store;
        if (!this.store.nodes || typeof this.store.nodes !== 'object') {
            this.store.nodes = { '/': { t: KIND_DIR } };
        }
        if (!this.store.nodes['/']) {
            this.store.nodes['/'] = { t: KIND_DIR };
        }
    }

    get nodes() {
        return this.store.nodes;
    }

    /**
     * @param {string} path
     * @returns {boolean}
     */
    exists(path) {
        return Object.hasOwn(this.nodes, normalizePath(path));
    }

    /**
     * @param {string} path
     * @returns {boolean}
     */
    isDir(path) {
        const node = this.nodes[normalizePath(path)];
        return node?.t === KIND_DIR;
    }

    /**
     * @param {string} path
     * @returns {{path: string, dir: boolean, size: number, mtime: number, origin: any}|null}
     */
    stat(path) {
        const normalized = normalizePath(path);
        const node = this.nodes[normalized];
        if (!node) return null;
        return {
            path: normalized,
            dir: node.t === KIND_DIR,
            size: node.t === KIND_FILE ? String(node.c ?? '').length : 0,
            mtime: Number(node.m ?? 0),
            origin: node.o ?? null,
        };
    }

    /**
     * 递归创建目录。
     * @param {string} path
     * @returns {void}
     */
    mkdirp(path) {
        const normalized = normalizePath(path);
        if (normalized === '/') return;
        const parts = normalized.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += `/${part}`;
            const node = this.nodes[current];
            if (node) {
                if (node.t !== KIND_DIR) {
                    throw new Error(`无法创建目录 ${current}：已存在同名文件`);
                }
                continue;
            }
            this.nodes[current] = { t: KIND_DIR };
        }
    }

    /**
     * 读取文件内容。目录会抛错（请用 listText）。
     * @param {string} path
     * @returns {string}
     */
    read(path) {
        const normalized = normalizePath(path);
        const node = this.nodes[normalized];
        if (!node) throw new Error(`文件不存在: ${normalized}`);
        if (node.t === KIND_DIR) throw new Error(`${normalized} 是目录，请改用目录列表`);
        return String(node.c ?? '');
    }

    /**
     * 写入文件（自动创建父目录）。
     * @param {string} path
     * @param {string} content
     * @param {any} [origin] 显式设置来源；省略则保留原有来源
     * @returns {{path: string, bytes: number, created: boolean}}
     */
    write(path, content, origin = undefined) {
        const normalized = normalizePath(path);
        if (normalized === '/') throw new Error('不能写入根目录');
        const text = String(content ?? '');

        const previous = this.nodes[normalized];
        if (previous?.t === KIND_DIR) {
            throw new Error(`${normalized} 是目录，不能当文件写入`);
        }

        this.mkdirp(parentOf(normalized));

        /** @type {Record<string, any>} */
        const node = { t: KIND_FILE, c: text, m: Date.now() };
        if (origin !== undefined) node.o = origin;
        else if (previous?.o) node.o = previous.o;

        this.nodes[normalized] = node;
        return { path: normalized, bytes: byteLength(text), created: !previous };
    }

    /**
     * 移动 / 重命名文件或目录（目录连同子树一起搬）。
     * @param {string} from
     * @param {string} to
     * @returns {{from: string, to: string, count: number}}
     */
    move(from, to) {
        const source = normalizePath(from);
        const target = normalizePath(to);

        if (source === '/') throw new Error('不能移动工作区根目录');
        if (source === target) return { from: source, to: target, count: 0 };
        if (!this.exists(source)) throw new Error(`找不到 ${source}`);
        if (target === source || target.startsWith(`${source}/`)) {
            throw new Error('不能把目录移动到它自己里面');
        }
        if (this.exists(target)) throw new Error(`${target} 已存在`);

        const parent = parentOf(target);
        if (parent !== '/' && this.exists(parent) && !this.isDir(parent)) {
            throw new Error(`${parent} 不是目录`);
        }
        this.mkdirp(parent);

        const moved = [];
        for (const key of Object.keys(this.nodes)) {
            if (key === source || key.startsWith(`${source}/`)) {
                moved.push(key);
            }
        }

        for (const key of moved) {
            const next = target + key.slice(source.length);
            this.nodes[next] = this.nodes[key];
            delete this.nodes[key];
        }

        return { from: source, to: target, count: moved.length };
    }

    /**
     * 删除文件或目录（递归）。
     * @param {string} path
     * @returns {number} 删除的节点数
     */
    remove(path) {
        const normalized = normalizePath(path);
        if (normalized === '/') throw new Error('不能删除工作区根目录');

        let count = 0;
        for (const key of Object.keys(this.nodes)) {
            if (key === normalized || key.startsWith(`${normalized}/`)) {
                delete this.nodes[key];
                count += 1;
            }
        }
        return count;
    }

    /**
     * 列目录。
     * @param {string} path
     * @returns {{name: string, path: string, dir: boolean, size: number, mtime: number}[]}
     */
    list(path) {
        const normalized = normalizePath(path);
        if (!this.isDir(normalized)) {
            throw new Error(`${normalized} 不是目录`);
        }
        const prefix = normalized === '/' ? '/' : `${normalized}/`;
        /** @type {{name: string, path: string, dir: boolean, size: number, mtime: number}[]} */
        const items = [];

        for (const [key, node] of Object.entries(this.nodes)) {
            if (key === '/' || !key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            if (rest.includes('/')) continue;
            items.push({
                name: rest,
                path: key,
                dir: node.t === KIND_DIR,
                size: node.t === KIND_FILE ? byteLength(String(node.c ?? '')) : 0,
                mtime: Number(node.m ?? 0),
            });
        }

        return items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.dir ? -1 : 1));
    }

    /**
     * 目录列表的文本形式，直接喂给模型。
     * @param {string} path
     * @returns {string}
     */
    listText(path) {
        const normalized = normalizePath(path);
        const items = this.list(normalized);
        if (!items.length) return `${normalized} (空目录)`;
        const width = Math.max(...items.map(item => item.name.length));
        const lines = items.map(item => {
            const name = `${item.name}${item.dir ? '/' : ''}`.padEnd(width + 1, ' ');
            return item.dir
                ? `  ${name}   <目录>`
                : `  ${name}   ${formatBytes(item.size)}`;
        });
        return `${normalized} (${items.length} 项)\n${lines.join('\n')}`;
    }

    /**
     * 所有文件路径。
     * @returns {string[]}
     */
    files() {
        return Object.keys(this.nodes).filter(key => this.nodes[key]?.t === KIND_FILE).sort();
    }

    /**
     * @returns {number}
     */
    totalBytes() {
        return Object.values(this.nodes).reduce((sum, node) => {
            return node?.t === KIND_FILE ? sum + byteLength(String(node.c ?? '')) : sum;
        }, 0);
    }

    /**
     * 已用空间摘要。
     * @returns {{files: number, dirs: number, bytes: number, text: string}}
     */
    stats() {
        const files = Object.values(this.nodes).filter(node => node?.t === KIND_FILE).length;
        const dirs = Object.values(this.nodes).filter(node => node?.t === KIND_DIR).length;
        const bytes = this.totalBytes();
        return { files, dirs, bytes, text: `${files} 文件 / ${dirs} 目录 / ${formatBytes(bytes)}` };
    }
}
