/**
 * 只读工具：read / grep。
 *
 * Scriptorium 把当前聊天启用的世界书镜像到 VFS 里，模型只能读，不能写回酒馆。
 */

import { formatGrepResult, grepWorkspace, parseGrepArgs } from './grep.js';
import { normalizePath } from './vfs.js';

export const READ_TOOL = 'read';
export const GREP_TOOL = 'grep';
export const TOOL_NAMES = [READ_TOOL, GREP_TOOL];

const MAX_READ_CHARS = 60_000;

const READ_DESCRIPTION = [
    'Read an entry from the world book mirror (a read-only, chat-scoped copy of the enabled world books).',
    'Layout: /world_book/<book name>/<uid>_<title>.md, one file per enabled entry, containing only the entry body.',
    'The complete, up-to-date file list is already in the system prompt under [世界书目录]: read those paths directly instead of listing directories to verify.',
    'startLine/endLine are 1-based and inclusive. A directory path returns its listing (only needed if the list there was truncated).',
].join(' ');

const GREP_DESCRIPTION = [
    'Search the world book mirror like ripgrep.',
    'Pass one rg-style argument string: PATTERN [PATH], plus flags -i (ignore case), -F (literal), -g GLOB, -C N (context), -l (files only), -c (counts), -m N (max hits).',
    'Use -- before a pattern that starts with a dash.',
    'Output: one line per hit as path:line:column: text, then a summary line.',
].join(' ');

const READ_PARAMETERS = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Absolute path taken from [世界书目录], e.g. /world_book/MyBook/0_intro.md',
        },
        startLine: {
            type: 'integer',
            description: 'Optional 1-based first line to return (inclusive).',
        },
        endLine: {
            type: 'integer',
            description: 'Optional 1-based last line to return (inclusive).',
        },
    },
    required: ['path'],
};

const GREP_PARAMETERS = {
    type: 'object',
    properties: {
        args: {
            type: 'string',
            description: 'rg-style arguments, e.g. 千束 -i -C 1 /world_book',
        },
    },
    required: ['args'],
};

/**
 * @param {import('./workspace.js').Scriptorium} workspace
 * @returns {{read: Function, grep: Function}}
 */
export function createToolHandlers(workspace) {
    /**
     * @param {{path: string, startLine?: number, endLine?: number}} args
     * @returns {Promise<string>}
     */
    async function read(args) {
        await workspace.ensure();
        const fs = workspace.fs;
        const target = normalizePath(args?.path);

        if (fs.isDir(target)) {
            return fs.listText(target);
        }

        const text = fs.read(target);
        const lines = text.split('\n');

        const start = positiveInt(args?.startLine);
        const end = positiveInt(args?.endLine);

        if (start === undefined && end === undefined) {
            return clip(text);
        }

        const from = start ?? 1;
        const to = Math.min(end ?? lines.length, lines.length);
        const slice = from > to ? [] : lines.slice(from - 1, to);

        const last = slice.length ? from + slice.length - 1 : from - 1;
        const header = `# ${target} lines ${from}-${last} of ${lines.length}`;
        return `${header}\n${clip(slice.join('\n'))}`;
    }

    /**
     * @param {{args?: string}} args
     * @returns {Promise<string>}
     */
    async function grep(args) {
        await workspace.ensure();
        const raw = String(args?.args ?? '');

        try {
            const { pattern, options } = parseGrepArgs(raw);
            const result = grepWorkspace(workspace.fs, pattern, options);
            return formatGrepResult(result, options);
        } catch (error) {
            // 最常见的一种误用：pattern 里有空格却没加引号，后半截被当成了路径
            const message = error?.message ?? '';
            const looksUnquoted = /\s/.test(raw.trim()) && !/["']/.test(raw);
            if (looksUnquoted && /路径不存在|只支持一个搜索路径/.test(message)) {
                throw new Error(`${message}（pattern 里有空格时请用引号，例如 "两个词" -g "*.md"）`);
            }
            throw error;
        }
    }

    return { read, grep };
}

/**
 * @param {any} context
 * @param {import('./workspace.js').Scriptorium} workspace
 * @returns {void}
 */
export function registerWorkspaceTools(context, workspace) {
    const handlers = createToolHandlers(workspace);
    const shouldRegister = () => workspace.isBound();

    context.registerFunctionTool({
        name: READ_TOOL,
        displayName: 'Read world book file',
        description: READ_DESCRIPTION,
        parameters: READ_PARAMETERS,
        action: handlers.read,
        shouldRegister,
    });

    context.registerFunctionTool({
        name: GREP_TOOL,
        displayName: 'Search world books',
        description: GREP_DESCRIPTION,
        parameters: GREP_PARAMETERS,
        action: handlers.grep,
        shouldRegister,
    });
}

/**
 * @param {any} context
 * @returns {void}
 */
export function unregisterWorkspaceTools(context) {
    for (const name of TOOL_NAMES) {
        try {
            context.unregisterFunctionTool(name);
        } catch (error) {
            console.warn(`[scriptorium] 注销工具 ${name} 失败`, error);
        }
    }
}

/**
 * @param {string} text
 * @returns {string}
 */
function clip(text) {
    if (text.length <= MAX_READ_CHARS) return text;
    return `${text.slice(0, MAX_READ_CHARS)}\n\n[已截断：文件共 ${text.length} 字符，超过单次读取上限 ${MAX_READ_CHARS}]`;
}

/**
 * @param {any} value
 * @returns {number|undefined}
 */
function positiveInt(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    const int = Math.trunc(number);
    return int > 0 ? int : undefined;
}
