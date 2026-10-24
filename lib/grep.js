/**
 * 工作区搜索（grep 工具）—— 参数和输出尽量对齐 ripgrep（rg）。
 *
 * 输出默认等同 `rg -n --no-heading`（也就是 `grep -rn` 的样子）：
 *   匹配行   path:行号:内容
 *   上下文行 path-行号-内容
 *   分组之间 --
 * 不带列号（要列号加 --column）、不带统计尾行（要统计加 --stats）。
 *
 * 和 rg 的差异：
 *   - 搜的是 VFS 镜像，不是磁盘；不给路径时搜调用方给的默认路径（工具里是 /world_book）。
 *   - 额外匹配文件名：条目标题只在文件名里（<uid>_<标题>.md），pattern 也会拿去匹配标题
 *     （去掉 uid 前缀和扩展名），命中记为第 0 行：path:0:文件名。--no-filename-match 关闭。
 *   - 正则是 JS 语法（默认 u 模式，编译失败退回非 u）；-P 只是兼容写法，不换引擎。
 *   - 长行默认只显示命中位置附近 300 字（-M 调整，-M 0 不限）。
 *   - 有超时和输出上限，超出会注明截断。
 *   - 忽略文件 / 隐藏文件 / 颜色 / 线程这类参数没有意义：接受，但不起作用。
 */

import { normalizePath } from './vfs.js';

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_COLUMNS = 300;
const MAX_OUTPUT_LINES = 400;
const MAX_OUTPUT_CHARS = 40_000;

/** -t / -T 认识的类型（--type-list 会列出来） */
const FILE_TYPES = {
    md: ['*.md', '*.markdown', '*.mdx'],
    markdown: ['*.md', '*.markdown', '*.mdx'],
    yaml: ['*.yaml', '*.yml'],
    json: ['*.json', '*.jsonl'],
    txt: ['*.txt'],
};

const SORT_KEYS = ['path', 'modified', 'accessed', 'created', 'none'];

const HELP_TEXT = `grep：ripgrep（rg）风格搜索。
用法：PATTERN [PATH...] [选项]，或 -e PATTERN [-e PATTERN...] [PATH...]
短选项可合并（-iC2），长选项可写 --context=2；-- 之后都当作位置参数。

匹配：
  -e, --regexp P        追加一个 pattern（可多次，任一命中即可）
  -f, --file PATH       从文件读 pattern，一行一个
  -F, --fixed-strings   按字面搜，不当正则
  -i / -s / -S          忽略大小写 / 区分大小写 / 智能（pattern 有大写才区分）
  -w, --word-regexp     整词匹配
  -x, --line-regexp     整行匹配
  -v, --invert-match    反选：输出不匹配的行
  -U, --multiline       允许跨行匹配；--multiline-dotall 让 . 也匹配换行
  --no-unicode          关闭 Unicode 模式
输出：
  -n / -N               显示 / 不显示行号（默认显示）
  --column              显示列号（按字符计）
  -b, --byte-offset     显示行首偏移（按字符计）
  -o, --only-matching   只输出匹配到的部分
  -r, --replace T       输出时把匹配替换成 T（$1 / \${name} / $$）
  -A N / -B N / -C N    匹配行之后 / 之前 / 前后的上下文行数
  --context-separator S / --no-context-separator
  --passthru            输出全部行（匹配行用 :，其余用 -）
  --heading / --no-heading   按文件分组 / 每行带路径（默认）
  -H / -I               带 / 不带文件名
  --vimgrep             每处匹配一行：path:行:列:内容
  --trim                去掉行首空白
  -M, --max-columns N   长行只显示命中附近 N 字（默认 ${DEFAULT_MAX_COLUMNS}，0 不限）
  --stats               末尾附统计
模式：
  -l, --files-with-matches    只列有匹配的文件
  --files-without-match       只列没有匹配的文件
  -c, --count                 每个文件的匹配行数；--count-matches 匹配次数；--include-zero 连 0 也列
  -m, --max-count N           每个文件最多 N 行匹配
  -q, --quiet                 只回答有没有匹配
  --files                     不搜索，只列出会被搜索的文件
  --type-list                 列出 -t 认识的类型
过滤：
  -g, --glob G          文件过滤，可多次；! 开头表示排除；后面的规则优先
  --iglob G             同上，不区分大小写；--glob-case-insensitive 让所有 -g 不区分
  -t / -T TYPE          只搜 / 不搜某类文件
  -d, --max-depth N     最大目录深度
  --sort / --sortr K    按 path | modified | none 排序（sortr 倒序）
扩展：
  默认也拿 pattern 匹配文件名里的标题，命中记为第 0 行（path:0:文件名）；--no-filename-match 关闭。`;

/**
 * 把参数字符串拆成 token：支持单引号 / 双引号（双引号里可用 \" \\ 转义），空白分隔。
 * 引号外的反斜杠原样保留（和 shell 不同）：模型常把 \d+ 直接写在引号外。
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
            // 同 shell：双引号里 \ 只转义 " 和 \，其余原样保留（"\d+" 才能当正则用）
            if (char === '\\' && quote === '"' && (input[index + 1] === '"' || input[index + 1] === '\\')) {
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

// ---------------------------------------------------------------------------
// 参数表
// ---------------------------------------------------------------------------

/**
 * @typedef {{value: boolean, apply: (options: any, value?: string) => void}} OptionSpec
 */

/** @returns {OptionSpec} */
const flag = (/** @type {(options: any) => void} */ apply) => ({ value: false, apply });
/** @returns {OptionSpec} */
const valued = (/** @type {(options: any, value: string) => void} */ apply) => ({ value: true, apply });
/** @returns {OptionSpec} */
const counted = (/** @type {(options: any, value: number) => void} */ apply) => ({ value: true, apply: (options, value) => apply(options, toCount(value)) });

const NOOP = flag(() => {});
const NOOP_VALUE = valued(() => {});

/** @type {Record<string, OptionSpec>} */
const LONG_OPTIONS = {
    // 匹配
    'regexp': valued((o, v) => o.patterns.push(v)),
    'file': valued((o, v) => o.patternFiles.push(v)),
    'fixed-strings': flag(o => { o.fixed = true; }),
    'no-fixed-strings': flag(o => { o.fixed = false; }),
    'ignore-case': flag(o => { o.caseMode = 'insensitive'; }),
    'case-sensitive': flag(o => { o.caseMode = 'sensitive'; }),
    'smart-case': flag(o => { o.caseMode = 'smart'; }),
    'word-regexp': flag(o => { o.word = true; }),
    'line-regexp': flag(o => { o.line = true; }),
    'invert-match': flag(o => { o.invert = true; }),
    'multiline': flag(o => { o.multiline = true; }),
    'no-multiline': flag(o => { o.multiline = false; }),
    'multiline-dotall': flag(o => { o.dotall = true; }),
    'no-multiline-dotall': flag(o => { o.dotall = false; }),
    'unicode': flag(o => { o.unicode = true; }),
    'no-unicode': flag(o => { o.unicode = false; }),
    'filename-match': flag(o => { o.filenameMatch = true; }),
    'no-filename-match': flag(o => { o.filenameMatch = false; }),

    // 输出
    'line-number': flag(o => { o.lineNumber = true; }),
    'no-line-number': flag(o => { o.lineNumber = false; }),
    'column': flag(o => { o.column = true; }),
    'no-column': flag(o => { o.column = false; }),
    'byte-offset': flag(o => { o.byteOffset = true; }),
    'only-matching': flag(o => { o.onlyMatching = true; }),
    'replace': valued((o, v) => { o.replace = v; }),
    'after-context': counted((o, n) => { o.after = n; }),
    'before-context': counted((o, n) => { o.before = n; }),
    'context': counted((o, n) => { o.before = n; o.after = n; }),
    'context-separator': valued((o, v) => { o.contextSeparator = v; }),
    'no-context-separator': flag(o => { o.contextSeparator = null; }),
    'passthru': flag(o => { o.passthru = true; }),
    'passthrough': flag(o => { o.passthru = true; }),
    'heading': flag(o => { o.heading = true; }),
    'no-heading': flag(o => { o.heading = false; }),
    'pretty': flag(o => { o.heading = true; o.lineNumber = true; }),
    'with-filename': flag(o => { o.withFilename = true; }),
    'no-filename': flag(o => { o.withFilename = false; }),
    'vimgrep': flag(o => { o.vimgrep = true; }),
    'trim': flag(o => { o.trim = true; }),
    'no-trim': flag(o => { o.trim = false; }),
    'max-columns': counted((o, n) => { o.maxColumns = n; }),
    'max-columns-preview': NOOP,
    'no-max-columns-preview': NOOP,
    'stats': flag(o => { o.stats = true; }),
    'no-stats': flag(o => { o.stats = false; }),

    // 模式
    'files-with-matches': flag(o => { o.mode = 'files-with-matches'; }),
    'files-without-match': flag(o => { o.mode = 'files-without-match'; }),
    'count': flag(o => { o.mode = 'count'; }),
    'count-matches': flag(o => { o.mode = 'count-matches'; }),
    'include-zero': flag(o => { o.includeZero = true; }),
    'max-count': counted((o, n) => { o.maxCount = n; }),
    'quiet': flag(o => { o.mode = 'quiet'; }),
    'files': flag(o => { o.mode = 'files'; }),
    'type-list': flag(o => { o.mode = 'type-list'; }),
    'help': flag(o => { o.mode = 'help'; }),

    // 过滤
    'glob': valued((o, v) => o.globs.push({ glob: v, ignoreCase: false })),
    'iglob': valued((o, v) => o.globs.push({ glob: v, ignoreCase: true })),
    'glob-case-insensitive': flag(o => { o.globIgnoreCase = true; }),
    'no-glob-case-insensitive': flag(o => { o.globIgnoreCase = false; }),
    'type': valued((o, v) => o.types.push(v)),
    'type-not': valued((o, v) => o.typesNot.push(v)),
    'max-depth': counted((o, n) => { o.maxDepth = n; }),
    'maxdepth': counted((o, n) => { o.maxDepth = n; }),
    'sort': valued((o, v) => setSort(o, v, false)),
    'sortr': valued((o, v) => setSort(o, v, true)),

    // 在镜像里没有意义的：接受但不起作用
    'pcre2': NOOP,
    'no-pcre2': NOOP,
    'auto-hybrid-regex': NOOP,
    'engine': NOOP_VALUE,
    'crlf': NOOP,
    'no-crlf': NOOP,
    'text': NOOP,
    'no-text': NOOP,
    'hidden': NOOP,
    'no-hidden': NOOP,
    'unrestricted': NOOP,
    'no-ignore': NOOP,
    'no-ignore-vcs': NOOP,
    'no-ignore-dot': NOOP,
    'no-ignore-parent': NOOP,
    'no-ignore-global': NOOP,
    'no-ignore-files': NOOP,
    'ignore': NOOP,
    'ignore-file': NOOP_VALUE,
    'follow': NOOP,
    'no-follow': NOOP,
    'no-messages': NOOP,
    'messages': NOOP,
    'no-config': NOOP,
    'null': NOOP,
    'search-zip': NOOP,
    'no-search-zip': NOOP,
    'encoding': NOOP_VALUE,
    'threads': NOOP_VALUE,
    'color': NOOP_VALUE,
    'colors': NOOP_VALUE,
};

/** @type {Record<string, string>} */
const SHORT_OPTIONS = {
    e: 'regexp', f: 'file', F: 'fixed-strings', i: 'ignore-case', s: 'case-sensitive', S: 'smart-case',
    w: 'word-regexp', x: 'line-regexp', v: 'invert-match', U: 'multiline', P: 'pcre2',
    n: 'line-number', N: 'no-line-number', o: 'only-matching', r: 'replace', b: 'byte-offset',
    A: 'after-context', B: 'before-context', C: 'context',
    l: 'files-with-matches', c: 'count', m: 'max-count', q: 'quiet',
    g: 'glob', t: 'type', T: 'type-not', d: 'max-depth', M: 'max-columns',
    H: 'with-filename', I: 'no-filename', p: 'pretty', a: 'text', z: 'search-zip',
    j: 'threads', u: 'unrestricted', L: 'follow', 0: 'null', h: 'help', E: 'encoding',
};

/**
 * @returns {Record<string, any>}
 */
function defaultOptions() {
    return {
        patterns: [],
        patternFiles: [],
        positional: [],
        fixed: false,
        caseMode: 'sensitive',
        word: false,
        line: false,
        invert: false,
        multiline: false,
        dotall: false,
        unicode: true,
        filenameMatch: true,
        lineNumber: true,
        column: false,
        byteOffset: false,
        onlyMatching: false,
        replace: null,
        before: 0,
        after: 0,
        contextSeparator: '--',
        passthru: false,
        heading: false,
        withFilename: true,
        vimgrep: false,
        trim: false,
        maxColumns: DEFAULT_MAX_COLUMNS,
        stats: false,
        mode: 'matches',
        includeZero: false,
        maxCount: null,
        globs: [],
        globIgnoreCase: false,
        types: [],
        typesNot: [],
        maxDepth: null,
        sort: 'path',
        sortReverse: false,
    };
}

/**
 * rg 风格参数串 → 选项。位置参数先原样放进 positional，pattern / 路径在 runGrep 里再分。
 *
 * @param {string} input
 * @returns {Record<string, any>}
 */
export function parseGrepArgs(input) {
    const tokens = tokenizeGrepArgs(String(input ?? ''));
    const options = defaultOptions();
    let endOfOptions = false;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];

        if (!endOfOptions && token === '--') {
            endOfOptions = true;
            continue;
        }

        if (!endOfOptions && token.startsWith('--')) {
            const equals = token.indexOf('=');
            const name = token.slice(2, equals === -1 ? undefined : equals);
            const inline = equals === -1 ? undefined : token.slice(equals + 1);
            const spec = LONG_OPTIONS[name];
            if (!spec) throw new Error(`不认识的选项 --${name}（--help 查看支持的选项）`);

            if (spec.value) {
                const value = inline ?? tokens[(index += 1)];
                if (value === undefined) throw new Error(`--${name} 后面缺少值`);
                spec.apply(options, value);
            } else {
                if (inline !== undefined) throw new Error(`--${name} 不接受值`);
                spec.apply(options);
            }
            continue;
        }

        if (!endOfOptions && token.length > 1 && token.startsWith('-')) {
            // 短选项可以合并：-iC2 = -i -C 2；带值的选项吃掉剩余部分或下一个 token
            for (let cursor = 1; cursor < token.length; cursor += 1) {
                const short = token[cursor];
                const name = SHORT_OPTIONS[short];
                if (!name) throw new Error(`不认识的选项 -${short}（--help 查看支持的选项）`);

                const spec = LONG_OPTIONS[name];
                if (spec.value) {
                    const rest = token.slice(cursor + 1);
                    const value = rest !== '' ? rest : tokens[(index += 1)];
                    if (value === undefined) throw new Error(`-${short} 后面缺少值`);
                    spec.apply(options, value);
                    break;
                }
                spec.apply(options);
            }
            continue;
        }

        options.positional.push(token);
    }

    return options;
}

/**
 * @param {any} value
 * @returns {number}
 */
function toCount(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`需要非负整数，收到：${value ?? '(空)'}`);
    return number;
}

/**
 * @param {Record<string, any>} options
 * @param {string} value
 * @param {boolean} reverse
 * @returns {void}
 */
function setSort(options, value, reverse) {
    if (!SORT_KEYS.includes(value)) throw new Error(`--sort 只支持 ${SORT_KEYS.join(' / ')}，收到：${value}`);
    options.sort = value;
    options.sortReverse = reverse;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 解析参数、搜索、按 rg 的格式输出。
 *
 * @param {any} fs WorkspaceFS
 * @param {string} input rg 风格参数串
 * @param {{defaultPaths?: string[], timeoutMs?: number}} [defaults]
 * @returns {string}
 */
export function runGrep(fs, input, defaults = {}) {
    const started = Date.now();
    const timeoutMs = defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const options = parseGrepArgs(input);

    if (options.mode === 'help') return HELP_TEXT;
    if (options.mode === 'type-list') {
        return Object.entries(FILE_TYPES).map(([name, globs]) => `${name}: ${globs.join(', ')}`).join('\n');
    }

    const positional = [...options.positional];
    const patterns = [...options.patterns];
    for (const file of options.patternFiles) patterns.push(...readPatternFile(fs, file));

    const listOnly = options.mode === 'files';
    // 用了 -e / -f 时，位置参数全是路径
    if (!listOnly && !options.patterns.length && !options.patternFiles.length) {
        if (!positional.length) throw new Error('缺少 pattern（--help 查看用法）');
        patterns.push(positional.shift());
    }

    const roots = positional.length ? positional : (defaults.defaultPaths ?? ['/']);
    const { files, missing } = collectFiles(fs, roots, options);
    if (!files.length && missing.length === roots.length) {
        throw new Error(`路径不存在: ${missing.join('、')}`);
    }

    const out = new Output();
    const notes = [];
    if (missing.length) {
        const looksLikeWords = missing.some(path => !path.startsWith('/'));
        notes.push(`路径不存在: ${missing.join('、')}${looksLikeWords ? '（pattern 里有空格时要用引号括起来）' : ''}`);
    }

    if (listOnly) {
        for (const path of files) out.push(path);
        return finish(out, notes, '没有符合条件的文件');
    }

    const matcher = patterns.length ? compileMatcher(patterns, options) : null;
    const stats = { scanned: 0, matchedFiles: 0, matchedLines: 0, matches: 0 };
    const state = { printedFile: false };
    let timedOut = false;

    for (const path of files) {
        if (out.truncated) break;
        if (Date.now() - started >= timeoutMs) {
            timedOut = true;
            break;
        }

        let text;
        try {
            text = fs.read(path);
        } catch {
            continue;
        }

        stats.scanned += 1;
        const found = searchFile(path, text, matcher, options);
        const hitLines = found.selected.length + (found.nameHit ? 1 : 0);
        if (hitLines) {
            stats.matchedFiles += 1;
            stats.matchedLines += hitLines;
            stats.matches += found.matchCount;
        }

        switch (options.mode) {
            case 'quiet':
                if (hitLines) return '有匹配';
                break;
            case 'files-with-matches':
                if (hitLines) out.push(path);
                break;
            case 'files-without-match':
                if (!hitLines) out.push(path);
                break;
            case 'count':
            case 'count-matches': {
                const value = options.mode === 'count' ? hitLines : found.matchCount;
                if (value || options.includeZero) out.push(options.withFilename ? `${path}:${value}` : String(value));
                break;
            }
            default:
                if (hitLines) printFile(out, found, options, state);
        }
    }

    if (out.truncated) notes.push('输出过多已截断：缩小路径，或用 -g / -t / -m / -l / -c 收窄');
    if (timedOut) notes.push(`超时（${timeoutMs}ms），结果不完整`);
    if (options.stats) {
        notes.push(`${stats.matchedLines} 个匹配行 · ${stats.matches} 处匹配 · ${stats.matchedFiles} 个文件有匹配 · 扫描 ${stats.scanned} 个文件 · ${Date.now() - started}ms`);
    }

    if (options.mode === 'quiet') return ['没有匹配', ...notes].join('\n');
    const empty = options.mode === 'files-without-match' ? '没有符合条件的文件' : `没有匹配（扫描 ${stats.scanned} 个文件）`;
    return finish(out, notes, empty);
}

/**
 * @param {Output} out
 * @param {string[]} notes
 * @param {string} empty 没有任何输出行时的提示（rg 什么都不打印，但工具返回空串会让模型困惑）
 * @returns {string}
 */
function finish(out, notes, empty) {
    if (!out.lines.length) return [empty, ...notes].join('\n');
    if (!notes.length) return out.lines.join('\n');
    return [...out.lines, '', ...notes.map(note => `—— ${note}`)].join('\n');
}

/**
 * 带上限的输出缓冲。
 */
class Output {
    constructor() {
        /** @type {string[]} */
        this.lines = [];
        this.chars = 0;
        this.truncated = false;
    }

    /**
     * @param {string} line
     * @returns {void}
     */
    push(line) {
        if (this.truncated) return;
        if (this.lines.length >= MAX_OUTPUT_LINES || this.chars + line.length > MAX_OUTPUT_CHARS) {
            this.truncated = true;
            return;
        }
        this.lines.push(line);
        this.chars += line.length + 1;
    }
}

/**
 * @param {any} fs
 * @param {string} file
 * @returns {string[]}
 */
function readPatternFile(fs, file) {
    const path = normalizePath(file);
    if (!fs.exists(path) || fs.isDir(path)) throw new Error(`-f 的文件不存在: ${file}`);
    const lines = splitLines(fs.read(path));
    return lines;
}

// ---------------------------------------------------------------------------
// 正则
// ---------------------------------------------------------------------------

/**
 * 把多个 pattern 编成一个正则（任一命中即可）。
 *
 * @param {string[]} patterns
 * @param {Record<string, any>} options
 * @returns {RegExp}
 */
function compileMatcher(patterns, options) {
    if (!options.multiline) {
        const hasNewline = patterns.some(pattern => pattern.includes('\n') || (!options.fixed && /\\n/.test(pattern)));
        if (hasNewline) throw new Error('pattern 里有换行（\\n）：跨行匹配要加 -U');
    }

    const parts = patterns.map(pattern => (options.fixed ? escapeRegExp(pattern) : pattern));
    let source = parts.length === 1 ? parts[0] : parts.map(part => `(?:${part})`).join('|');
    if (options.line) source = `^(?:${source})$`;

    const insensitive = options.caseMode === 'insensitive'
        || (options.caseMode === 'smart' && !patterns.some(pattern => hasUppercase(pattern, options.fixed)));

    /**
     * @param {boolean} unicode
     * @returns {RegExp}
     */
    const build = (unicode) => {
        let body = source;
        if (options.word) {
            const wordChar = unicode ? '[\\p{L}\\p{N}\\p{M}_]' : '[A-Za-z0-9_]';
            body = `(?<!${wordChar})(?:${body})(?!${wordChar})`;
        }
        let flags = 'g';
        if (insensitive) flags += 'i';
        if (options.multiline) flags += 'm';
        if (options.dotall) flags += 's';
        if (unicode) flags += 'u';
        return new RegExp(body, flags);
    };

    try {
        return build(options.unicode);
    } catch (error) {
        // u 模式更严格（比如 \- 这种多余转义会报错），退回非 u 再试一次
        if (options.unicode) {
            try {
                return build(false);
            } catch {
                // 两种都不行，报 u 模式下的原始错误
            }
        }
        throw new Error(`正则表达式无效：${error?.message ?? error}（要按字面搜请加 -F）`);
    }
}

/**
 * smart-case 用：pattern 里有没有大写字母（转义序列不算）。
 * @param {string} pattern
 * @param {boolean} fixed
 * @returns {boolean}
 */
function hasUppercase(pattern, fixed) {
    const literal = fixed ? pattern : pattern.replace(/\\./g, '');
    return /\p{Lu}/u.test(literal);
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 一行（或一段文本）里的所有匹配。
 *
 * @param {RegExp} regex 带 g
 * @param {string} text
 * @returns {{start: number, end: number, match: RegExpExecArray}[]}
 */
function findSpans(regex, text) {
    /** @type {{start: number, end: number, match: RegExpExecArray}[]} */
    const spans = [];
    regex.lastIndex = 0;

    let match;
    while ((match = regex.exec(text)) !== null) {
        spans.push({ start: match.index, end: match.index + match[0].length, match });
        if (match[0] === '') {
            // 空匹配要手动前进，u 模式下别把代理对拆开
            const code = text.charCodeAt(regex.lastIndex);
            regex.lastIndex += regex.unicode && code >= 0xd800 && code <= 0xdbff ? 2 : 1;
            if (regex.lastIndex > text.length) break;
        }
    }
    return spans;
}

// ---------------------------------------------------------------------------
// 文件选择
// ---------------------------------------------------------------------------

/**
 * 根据路径、glob、类型、深度选出要搜的文件。显式给出的文件路径不受过滤影响（同 rg）。
 *
 * @param {any} fs
 * @param {string[]} roots
 * @param {Record<string, any>} options
 * @returns {{files: string[], missing: string[]}}
 */
function collectFiles(fs, roots, options) {
    const all = fs.files();
    const accept = buildFileFilter(options);
    /** @type {string[]} */
    const files = [];
    /** @type {string[]} */
    const missing = [];
    const seen = new Set();

    for (const raw of roots) {
        let root;
        try {
            root = normalizePath(raw);
        } catch {
            missing.push(raw);
            continue;
        }
        if (!fs.exists(root)) {
            missing.push(raw);
            continue;
        }

        if (!fs.isDir(root)) {
            if (!seen.has(root)) {
                seen.add(root);
                files.push(root);
            }
            continue;
        }

        const prefix = root === '/' ? '/' : `${root}/`;
        for (const path of all) {
            if (!path.startsWith(prefix) || seen.has(path)) continue;
            if (!accept(path.slice(prefix.length), path)) continue;
            seen.add(path);
            files.push(path);
        }
    }

    sortFiles(fs, files, options);
    return { files, missing };
}

/**
 * @param {Record<string, any>} options
 * @returns {(relative: string, absolute: string) => boolean}
 */
function buildFileFilter(options) {
    const globs = options.globs.map((/** @type {{glob: string, ignoreCase: boolean}} */ item) => {
        const negated = item.glob.startsWith('!');
        const body = negated ? item.glob.slice(1) : item.glob;
        return {
            negated,
            // 含 / 的 glob 按相对路径匹配；不含 / 的匹配任意一层的名字（文件名或目录名），同 gitignore
            anchored: body.includes('/'),
            regex: globToRegExp(body.replace(/^\//, ''), item.ignoreCase || options.globIgnoreCase),
        };
    });
    const hasInclude = globs.some(item => !item.negated);
    const includeTypes = resolveTypes(options.types);
    const excludeTypes = resolveTypes(options.typesNot);

    return (relative, absolute) => {
        const segments = relative.split('/');
        if (options.maxDepth !== null && segments.length > options.maxDepth) return false;

        const name = segments[segments.length - 1];
        if (includeTypes && !includeTypes.some(regex => regex.test(name))) return false;
        if (excludeTypes && excludeTypes.some(regex => regex.test(name))) return false;

        if (!globs.length) return true;

        // 后面的规则覆盖前面的；一条都没命中时，有「包含」规则就排除
        let decision;
        for (const item of globs) {
            const hit = item.anchored
                ? item.regex.test(relative) || item.regex.test(absolute.slice(1))
                : segments.some(segment => item.regex.test(segment));
            if (hit) decision = !item.negated;
        }
        return decision ?? !hasInclude;
    };
}

/**
 * @param {string[]} names
 * @returns {RegExp[]|null}
 */
function resolveTypes(names) {
    if (!names.length) return null;
    return names.flatMap(name => {
        const globs = FILE_TYPES[/** @type {keyof typeof FILE_TYPES} */ (name)];
        if (!globs) throw new Error(`不认识的文件类型 ${name}（--type-list 查看）`);
        return globs.map(glob => globToRegExp(glob, false));
    });
}

/**
 * glob → RegExp：** / * / ? / [abc] / [!abc] / {a,b}。
 *
 * @param {string} glob
 * @param {boolean} ignoreCase
 * @returns {RegExp}
 */
function globToRegExp(glob, ignoreCase) {
    return new RegExp(`^${globBody(glob)}$`, ignoreCase ? 'i' : '');
}

/**
 * @param {string} glob
 * @returns {string}
 */
function globBody(glob) {
    let out = '';

    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];

        if (char === '*') {
            if (glob[index + 1] === '*') {
                index += 1;
                if (glob[index + 1] === '/') {
                    out += '(?:.*/)?';
                    index += 1;
                } else {
                    out += '.*';
                }
            } else {
                out += '[^/]*';
            }
        } else if (char === '?') {
            out += '[^/]';
        } else if (char === '[') {
            const close = glob.indexOf(']', index + 2);
            if (close === -1) {
                out += '\\[';
                continue;
            }
            let body = glob.slice(index + 1, close);
            if (body.startsWith('!')) body = `^${body.slice(1)}`;
            out += `[${body.replace(/\\/g, '\\\\')}]`;
            index = close;
        } else if (char === '{') {
            const close = matchingBrace(glob, index);
            if (close === -1) {
                out += '\\{';
                continue;
            }
            const alternatives = splitTopLevel(glob.slice(index + 1, close));
            out += `(?:${alternatives.map(globBody).join('|')})`;
            index = close;
        } else {
            out += escapeRegExp(char);
        }
    }

    return out;
}

/**
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function matchingBrace(text, open) {
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
        if (text[index] === '{') depth += 1;
        else if (text[index] === '}') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

/**
 * {a,b{c,d}} 里按最外层逗号切。
 * @param {string} text
 * @returns {string[]}
 */
function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const char of text) {
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
        if (char === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts;
}

/**
 * @param {any} fs
 * @param {string[]} files
 * @param {Record<string, any>} options
 * @returns {void}
 */
function sortFiles(fs, files, options) {
    if (options.sort === 'path') {
        files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } else if (options.sort !== 'none') {
        // 镜像里只有修改时间，accessed / created 也按它排
        files.sort((a, b) => Number(fs.stat(a)?.mtime ?? 0) - Number(fs.stat(b)?.mtime ?? 0));
    }
    if (options.sortReverse) files.reverse();
}

// ---------------------------------------------------------------------------
// 搜索单个文件
// ---------------------------------------------------------------------------

/**
 * @typedef {{start: number, end: number, match: RegExpExecArray}} Span
 * @typedef {{
 *   path: string,
 *   lines: string[],
 *   selected: number[],
 *   spans: Map<number, Span[]>,
 *   nameHit: {text: string, spans: Span[]}|null,
 *   matchCount: number,
 * }} FileResult
 */

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
    if (!text) return [];
    const lines = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
    // 末尾换行后面那个空串不算一行（同 rg）
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/**
 * @param {string[]} lines
 * @returns {number[]}
 */
function lineStarts(lines) {
    const starts = [];
    let offset = 0;
    for (const line of lines) {
        starts.push(offset);
        offset += line.length + 1;
    }
    return starts;
}

/**
 * @param {number[]} starts
 * @param {number} offset
 * @returns {number}
 */
function lineAt(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return low;
}

/**
 * @param {string} path
 * @param {string} text
 * @param {RegExp|null} matcher
 * @param {Record<string, any>} options
 * @returns {FileResult}
 */
function searchFile(path, text, matcher, options) {
    const lines = splitLines(text);
    /** @type {FileResult} */
    const result = { path, lines, selected: [], spans: new Map(), nameHit: null, matchCount: 0 };
    if (!matcher) return result;

    const limit = options.maxCount ?? Infinity;
    if (limit <= 0) return result;

    if (options.filenameMatch && !options.invert) {
        result.nameHit = matchFileName(path, matcher);
        if (result.nameHit) result.matchCount += result.nameHit.spans.length;
    }

    const budget = limit - (result.nameHit ? 1 : 0);
    if (budget <= 0) return result;

    if (options.multiline) {
        searchMultiline(result, matcher, options, budget);
        return result;
    }

    for (let index = 0; index < lines.length && result.selected.length < budget; index += 1) {
        const spans = findSpans(matcher, lines[index]);
        if ((spans.length > 0) === options.invert) continue;

        result.selected.push(index);
        if (options.invert) {
            result.matchCount += 1;
        } else {
            result.spans.set(index, spans);
            result.matchCount += spans.length;
        }
    }
    return result;
}

/**
 * -U：在整段文本上匹配，匹配跨过的每一行都算匹配行。
 * @param {FileResult} result
 * @param {RegExp} matcher
 * @param {Record<string, any>} options
 * @param {number} budget
 * @returns {void}
 */
function searchMultiline(result, matcher, options, budget) {
    const { lines } = result;
    const starts = lineStarts(lines);
    const text = lines.join('\n');
    /** @type {Set<number>} */
    const covered = new Set();
    let found = 0;

    for (const span of findSpans(matcher, text)) {
        if (found >= budget) break;
        found += 1;

        const first = lineAt(starts, span.start);
        const last = lineAt(starts, Math.max(span.start, span.end - 1));
        const local = { start: span.start - starts[first], end: span.end - starts[first], match: span.match };
        result.spans.set(first, [...(result.spans.get(first) ?? []), local]);
        for (let index = first; index <= last; index += 1) covered.add(index);
    }

    if (options.invert) {
        result.spans.clear();
        result.selected = lines.map((_, index) => index).filter(index => !covered.has(index));
        result.matchCount += result.selected.length;
    } else {
        result.selected = [...covered].sort((a, b) => a - b);
        result.matchCount += found;
    }
}

/**
 * 拿 pattern 匹配文件名里的标题（去掉 uid 前缀和扩展名）。
 * @param {string} path
 * @param {RegExp} matcher
 * @returns {{text: string, spans: Span[]}|null}
 */
function matchFileName(path, matcher) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const stem = name.replace(/\.[^.]+$/, '');
    const prefix = /^\d+_/.exec(stem)?.[0] ?? '';
    const title = stem.slice(prefix.length);
    if (!title) return null;

    // 空匹配（比如空 pattern）不算文件名命中，否则每个文件都会多一行
    const spans = findSpans(matcher, title).filter(span => span.end > span.start);
    if (!spans.length) return null;

    return {
        text: name,
        spans: spans.map(span => ({ ...span, start: span.start + prefix.length, end: span.end + prefix.length })),
    };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/**
 * @param {Output} out
 * @param {FileResult} found
 * @param {Record<string, any>} options
 * @param {{printedFile: boolean}} state
 * @returns {void}
 */
function printFile(out, found, options, state) {
    const { path, lines, selected, spans, nameHit } = found;

    if (options.vimgrep) {
        if (nameHit) {
            for (const span of nameHit.spans) out.push(`${path}:0:${span.start + 1}:${render(nameHit.text, [span], options)}`);
        }
        for (const index of selected) {
            const lineSpans = spans.get(index) ?? [];
            for (const span of lineSpans) out.push(`${path}:${index + 1}:${span.start + 1}:${render(lines[index], [span], options)}`);
            if (!lineSpans.length) out.push(`${path}:${index + 1}:1:${render(lines[index], [], options)}`);
        }
        return;
    }

    const hasContext = !options.passthru && (options.before > 0 || options.after > 0);
    const separator = hasContext && options.contextSeparator !== null ? options.contextSeparator : null;

    if (options.heading) {
        if (state.printedFile) out.push('');
        if (options.withFilename) out.push(path);
    } else if (state.printedFile && separator !== null) {
        out.push(separator);
    }
    state.printedFile = true;

    const starts = options.byteOffset ? lineStarts(lines) : null;

    if (options.onlyMatching) {
        if (nameHit) {
            for (const span of nameHit.spans) out.push(formatLine(path, 0, { column: span.start + 1, offset: 0 }, renderMatch(span, options), ':', options));
        }
        for (const index of selected) {
            for (const span of spans.get(index) ?? []) {
                if (span.end === span.start) continue;
                const offset = starts ? starts[index] + span.start : undefined;
                out.push(formatLine(path, index + 1, { column: span.start + 1, offset }, renderMatch(span, options), ':', options));
            }
        }
        return;
    }

    if (nameHit) {
        out.push(formatLine(path, 0, { column: nameHit.spans[0].start + 1, offset: 0 }, render(nameHit.text, nameHit.spans, options), ':', options));
    }

    const ranges = options.passthru
        ? (lines.length ? [[0, lines.length - 1]] : [])
        : mergeRanges(selected, options.before, options.after, lines.length);
    const chosen = new Set(selected);

    for (const [groupIndex, [from, to]] of ranges.entries()) {
        if (groupIndex > 0 && separator !== null) out.push(separator);
        for (let index = from; index <= to; index += 1) {
            const isMatch = chosen.has(index);
            const lineSpans = isMatch ? (spans.get(index) ?? []) : [];
            const column = lineSpans.length ? lineSpans[0].start + 1 : undefined;
            const text = render(lines[index], lineSpans, options);
            out.push(formatLine(path, index + 1, { column, offset: starts?.[index] }, text, isMatch ? ':' : '-', options));
        }
    }
}

/**
 * 匹配行前后各扩上下文，重叠或相邻的合并成一组。
 * @param {number[]} selected 升序
 * @param {number} before
 * @param {number} after
 * @param {number} total
 * @returns {number[][]}
 */
function mergeRanges(selected, before, after, total) {
    /** @type {number[][]} */
    const ranges = [];
    for (const index of selected) {
        const from = Math.max(0, index - before);
        const to = Math.min(total - 1, index + after);
        const last = ranges[ranges.length - 1];
        if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
        else ranges.push([from, to]);
    }
    return ranges;
}

/**
 * path[sep]行号[sep]列号[sep]偏移[sep]内容；匹配行 sep 是 :，上下文行是 -（同 rg）。
 *
 * @param {string} path
 * @param {number} lineNumber
 * @param {{column?: number, offset?: number}} extra
 * @param {string} text
 * @param {string} sep
 * @param {Record<string, any>} options
 * @returns {string}
 */
function formatLine(path, lineNumber, extra, text, sep, options) {
    const parts = [];
    if (options.withFilename && !options.heading) parts.push(path);
    if (options.lineNumber) parts.push(String(lineNumber));
    if (options.column && extra.column !== undefined) parts.push(String(extra.column));
    if (options.byteOffset && extra.offset !== undefined) parts.push(String(extra.offset));
    return parts.length ? `${parts.join(sep)}${sep}${text}` : text;
}

/**
 * 一整行的显示文本：替换 → 去行首空白 → 长行截断（以第一处匹配为中心）。
 * @param {string} text
 * @param {Span[]} spans
 * @param {Record<string, any>} options
 * @returns {string}
 */
function render(text, spans, options) {
    let value = text;
    let focus = spans.find(span => span.end > span.start)?.start ?? 0;

    if (options.replace !== null && spans.length) value = replaceSpans(text, spans, options.replace);
    if (options.trim) {
        const trimmed = value.trimStart();
        focus = Math.max(0, focus - (value.length - trimmed.length));
        value = trimmed;
    }
    return clipColumns(value, focus, options.maxColumns);
}

/**
 * -o 的显示文本。
 * @param {Span} span
 * @param {Record<string, any>} options
 * @returns {string}
 */
function renderMatch(span, options) {
    const value = options.replace !== null ? expandReplacement(options.replace, span.match) : span.match[0];
    return clipColumns(value, 0, options.maxColumns);
}

/**
 * @param {string} text
 * @param {Span[]} spans
 * @param {string} template
 * @returns {string}
 */
function replaceSpans(text, spans, template) {
    let out = '';
    let cursor = 0;
    for (const span of spans) {
        if (span.start < cursor) continue;
        out += text.slice(cursor, span.start) + expandReplacement(template, span.match);
        cursor = Math.min(span.end, text.length);
    }
    return out + text.slice(cursor);
}

/**
 * rg 的替换语法：$1 / ${1} / $name / ${name} / $$。不存在的组替换成空串。
 * @param {string} template
 * @param {RegExpExecArray} match
 * @returns {string}
 */
function expandReplacement(template, match) {
    return template.replace(/\$(\$|\{([^}]*)\}|([A-Za-z0-9_]+))/g, (_all, token, braced, bare) => {
        if (token === '$') return '$';
        const name = braced ?? bare;
        const value = /^\d+$/.test(name) ? match[Number(name)] : match.groups?.[name];
        return value ?? '';
    });
}

/**
 * 超过 max 字的行只保留 focus 附近一段，两头用 … 标出；跨行匹配的换行显示成 ⏎。
 * @param {string} value
 * @param {number} focus
 * @param {number} max 0 表示不限
 * @returns {string}
 */
function clipColumns(value, focus, max) {
    if (!max || value.length <= max) return flatten(value);
    const start = Math.max(0, Math.min(focus - Math.floor(max / 3), value.length - max));
    const head = start > 0 ? '…' : '';
    const tail = start + max < value.length ? '…' : '';
    return flatten(`${head}${value.slice(start, start + max)}${tail}`);
}

/**
 * @param {string} value
 * @returns {string}
 */
function flatten(value) {
    return value.replace(/\r?\n/g, '⏎');
}
