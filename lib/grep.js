/**
 * 工作区搜索（grep）—— at.grep 和 grep 工具共用这一份实现。
 *
 * 设计要点：
 *   - 正则只编译一次，所有文件共用；
 *   - 行号是增量数的：匹配本来就按位置递增，整体仍是 O(n)；
 *   - 有结果上限和超时（默认 2s），大工作区不会把页面卡死。
 */

/**
 * 把 rg 风格的参数字符串拆成 token。
 *
 * 支持单引号 / 双引号（双引号里可用 \" 转义），空白分隔。
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeGrepArgs(input) {
    /** @type {string[]} */
    const tokens = [];

    let current = '';
    let quote = '';
    let started = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];

        if (quote) {
            if (char === quote) {
                quote = '';
                continue;
            }
            if (char === '\\' && quote === '"' && index + 1 < input.length) {
                current += input[index + 1];
                index += 1;
                continue;
            }
            current += char;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            started = true;
            continue;
        }

        if (/\s/.test(char)) {
            if (started) {
                tokens.push(current);
                current = '';
                started = false;
            }
            continue;
        }

        current += char;
        started = true;
    }

    if (quote) throw new Error('引号没有闭合');
    if (started) tokens.push(current);

    return tokens;
}

/**
 * rg 风格字符串 → grepWorkspace 的 options。
 *
 *   grep('千束 -i -g "*.md" -C 1 /world_book')
 *   grep('-F "a.b" -- -开头的内容')
 *
 * 支持：-i（忽略大小写）、-F（字面量）、-l（只列文件）、-c（计数）、
 *       -g GLOB、-C N（上下文）、-m N（命中上限）、--（后面全是位置参数）。
 *
 * @param {string} input
 * @returns {{pattern: string, options: Record<string, any>}}
 */
export function parseGrepArgs(input) {
    const tokens = tokenizeGrepArgs(String(input ?? ''));

    /** @type {Record<string, any>} */
    const options = {};
    /** @type {string[]} */
    const positional = [];
    let literalMode = false;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];

        if (!literalMode && token === '--') {
            literalMode = true;
            continue;
        }

        if (!literalMode && token.length > 1 && token.startsWith('-')) {
            const flag = token.slice(1);

            if (flag === 'i') options.ignoreCase = true;
            else if (flag === 'F') options.fixed = true;
            else if (flag === 'l') options.mode = 'files';
            else if (flag === 'c') options.mode = 'count';
            else if (flag === 'g') options.glob = tokens[(index += 1)];
            else if (flag.startsWith('g')) options.glob = flag.slice(1);
            else if (flag === 'C') options.context = toNumber(tokens[(index += 1)]);
            else if (flag.startsWith('C')) options.context = toNumber(flag.slice(1));
            else if (flag === 'm') options.maxResults = toNumber(tokens[(index += 1)]);
            else if (flag.startsWith('m')) options.maxResults = toNumber(flag.slice(1));
            else throw new Error(`不认识的选项 -${flag}（支持 -i -F -l -c -g GLOB -C N -m N，以及 --）`);
            continue;
        }

        positional.push(token);
    }

    if (options.glob === undefined && tokens.some(token => token === '-g')) {
        throw new Error('-g 后面缺少 GLOB');
    }
    if (positional.length === 0) throw new Error('缺少 pattern');
    if (positional.length > 2) throw new Error('只支持一个搜索路径；要搜多个目录请分多次调用或用 glob');

    return { pattern: positional[0], options: { ...options, path: positional[1] } };
}

/**
 * @param {any} value
 * @returns {number}
 */
function toNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`需要数字，收到：${value ?? '(空)'}`);
    return number;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * glob → RegExp：支持 `**`（跨目录）、`*`（不跨目录）、`?`。
 * 不含 `/` 的 glob 只匹配文件名。
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
    let out = '^';

    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === '*') {
            if (glob[index + 1] === '*') {
                out += '.*';
                index += 1;
            } else {
                out += '[^/]*';
            }
        } else if (char === '?') {
            out += '[^/]';
        } else {
            out += escapeRegExp(char);
        }
    }

    return new RegExp(`${out}$`);
}

/**
 * 工作区搜索（ripgrep 风格的单遍扫描）。
 *
 * 设计要点：
 *   - 正则只编译一次，所有文件共用；
 *   - 行号是增量数的：匹配本来就是按位置递增的，所以整体仍是 O(n)；
 *   - 有结果上限和超时（默认 2s），大工作区也不会把页面卡死。
 *
 * `mode` 对应 rg 的三种输出：
 *   - `matches`（默认）：一条命中一行，带行号列号
 *   - `files`：等价 `rg -l`，只给有命中的文件
 *   - `count`：等价 `rg -c`，每文件计数
 *
 * @param {any} fs
 * @param {string|RegExp} pattern
 * @param {any} [options]
 * @returns {any}
 */
export function grepWorkspace(fs, pattern, options = {}) {
    const started = Date.now();

    const mode = options.mode === 'files' || options.mode === 'count' ? options.mode : 'matches';
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Number(options.timeoutMs)) : 2000;
    const limit = Number.isFinite(options.maxResults) ? Math.max(1, Math.trunc(options.maxResults)) : 200;
    const context = Number.isFinite(options.context) ? Math.max(0, Math.trunc(options.context)) : 0;

    const source = options.fixed ? escapeRegExp(String(pattern)) : String(pattern);
    const flags = ['g', 'm'];
    if (options.ignoreCase) flags.push('i');

    // `\p{...}` 这类 Unicode 属性必须先开 u 才能用；没开的话会被当成普通字符，静默搜不到
    const wantsUnicode = options.unicode === true || /\\[pP]\{/.test(source);
    if (wantsUnicode) flags.push('u');

    /** @type {RegExp} */
    let regex;
    try {
        regex = new RegExp(source, flags.join(''));
    } catch (error) {
        const hint = wantsUnicode
            ? '（Unicode 属性要写成 \\p{Script=Han} 这种形式；要搜字面量请加 fixed: true）'
            : '';
        throw new Error(`正则表达式无效：${error?.message ?? error}${hint}`);
    }

    const root = typeof options.path === 'string' && options.path.trim() ? options.path.trim() : '/';
    if (!fs.exists(root)) throw new Error(`路径不存在: ${root}`);

    const globText = typeof options.glob === 'string' ? options.glob.trim() : '';
    const glob = globText ? globToRegExp(globText) : null;
    const globMatchesPath = globText.includes('/');
    const prefix = root === '/' ? '/' : (root.endsWith('/') ? root : `${root}/`);
    const candidates = fs.isDir(root)
        ? fs.files().filter(path => path.startsWith(prefix))
        : [root];

    /** @type {any[]} */
    const matches = [];
    /** @type {any[]} */
    const files = [];

    let total = 0;
    let scanned = 0;
    let truncated = false;
    let timedOut = false;

    outer: for (const path of candidates) {
        if (Date.now() - started >= timeoutMs) {
            timedOut = true;
            break;
        }

        if (glob) {
            const target = globMatchesPath ? path : path.slice(path.lastIndexOf('/') + 1);
            if (!glob.test(target)) continue;
        }

        let text;
        try {
            text = fs.read(path);
        } catch {
            continue;
        }

        scanned += 1;
        let fileCount = 0;

        let counted = 0;
        let line = 1;
        let lineStart = 0;

        const locate = (/** @type {number} */ index) => {
            for (let cursor = counted; cursor < index; cursor += 1) {
                if (text.charCodeAt(cursor) === 10) {
                    line += 1;
                    lineStart = cursor + 1;
                }
            }
            counted = Math.max(counted, index);
            return { line, column: index - lineStart + 1 };
        };

        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match[0] === '') {
                regex.lastIndex += 1;
                if (regex.lastIndex > text.length) break;
                continue;
            }

            fileCount += 1;
            total += 1;

            if (mode !== 'matches') {
                if (mode === 'files') break;
                continue;
            }

            const at = locate(match.index);
            const lineEnd = text.indexOf('\n', match.index + match[0].length);
            const lineText = text
                .slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
                .replace(/\r$/, '');

            /** @type {Record<string, any>} */
            const hit = {
                path,
                line: at.line,
                column: at.column,
                text: clipLine(lineText),
            };

            if (context > 0) {
                hit.before = contextLines(text, lineStart, -context);
                hit.after = contextLines(text, lineEnd === -1 ? text.length : lineEnd, context);
            }

            matches.push(hit);

            if (matches.length >= limit) {
                truncated = true;
                break outer;
            }
        }

        if (fileCount > 0) {
            files.push(mode === 'files' ? path : { path, count: fileCount });
        }
    }

    const result = {
        total,
        truncated,
        timedOut,
        scanned,
        durationMs: Date.now() - started,
    };

    if (mode !== 'matches') return { ...result, files };
    return { ...result, matches };
}

/**
 * @param {string} text
 * @returns {string}
 */
function clipLine(text) {
    const single = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    return single;
}

/**
 * 取匹配行前/后的若干行。
 * @param {string} text
 * @param {number} from 行边界
 * @param {number} count 负数往前，正数往后
 * @returns {string[]}
 */
function contextLines(text, from, count) {
    /** @type {string[]} */
    const lines = [];

    if (count < 0) {
        let end = from > 0 ? from - 1 : -1;
        for (let index = 0; index < -count && end > 0; index += 1) {
            const start = text.lastIndexOf('\n', end - 1) + 1;
            lines.unshift(text.slice(start, end).replace(/\r$/, ''));
            end = start - 1;
        }
        return lines;
    }

    let start = from + 1;
    for (let index = 0; index < count && start < text.length; index += 1) {
        const end = text.indexOf('\n', start);
        lines.push(text.slice(start, end === -1 ? text.length : end).replace(/\r$/, ''));
        if (end === -1) break;
        start = end + 1;
    }
    return lines;
}

/**
 * 把搜索结果渲染成文本（给 grep 工具用，模型读起来比 JSON 省 token）。
 *
 * 默认格式（对齐 ripgrep）：
 *   /world_book/x/entries/0_a.md:3:7: 千束站在门口。
 *
 * @param {any} result grepWorkspace 的返回值
 * @param {any} [options] 原始参数（用来显示截断阈值等）
 * @returns {string}
 */
export function formatGrepResult(result, options = {}) {
    /** @type {string[]} */
    const lines = [];
    const mode = options.mode === 'files' || options.mode === 'count' ? options.mode : 'matches';

    if (mode === 'files') {
        for (const path of result.files ?? []) lines.push(path);
    } else if (mode === 'count') {
        for (const file of result.files ?? []) lines.push(`${file.path}: ${file.count}`);
    } else {
        for (const match of result.matches ?? []) {
            lines.push(`${match.path}:${match.line}:${match.column}: ${flatten(match.text)}`);
            for (const before of match.before ?? []) lines.push(`  - ${flatten(before)}`);
            for (const after of match.after ?? []) lines.push(`  - ${flatten(after)}`);
        }
    }

    if (!lines.length) {
        lines.push(`没有匹配（扫描 ${result.scanned} 个文件，${result.durationMs}ms）`);
        return lines.join('\n');
    }

    const notes = [];
    notes.push(`${result.total} 条命中`);
    notes.push(`扫描 ${result.scanned} 个文件`);
    notes.push(`${result.durationMs}ms`);
    if (result.truncated) notes.push(`已截断到 ${options.maxResults ?? result.matches?.length ?? 0} 条，可用 maxResults 调整`);
    if (result.timedOut) notes.push('超时，结果不完整');

    lines.push('', `—— ${notes.join(' · ')}`);
    return lines.join('\n');
}

/**
 * @param {any} value
 * @returns {string}
 */
function flatten(value) {
    return String(value ?? '').replace(/\r?\n/g, '⏎');
}
