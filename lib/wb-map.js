/**
 * SillyTavern 世界书条目 <-> 工作区文件（`*.yaml` + `*.md`）的双向映射。
 *
 * 字段命名参考 elegant-character-card 的 `world_book/entries` 约定：
 *   - 可读性好的常用字段放 yaml 顶层（index / name / key / position ...）；
 *   - 其余 SillyTavern 原生字段原样收纳进 `other`，保证来回转换不丢信息；
 *   - 条目正文 `content` 不写进 yaml，单独放在同名 `.md`。
 */

export const POSITION_NAMES = ['beforeChar', 'afterChar', 'beforeAn', 'afterAn', 'fixed', 'beforeEm', 'afterEm', 'outlet'];
export const LOGIC_NAMES = ['andAny', 'notAll', 'notAny', 'andAll'];
export const ROLE_NAMES = ['system', 'user', 'model'];
export const ACTIVATION_MODES = ['keyword', 'always', 'vector'];

export const DEFAULT_ORDER = 100;
export const DEFAULT_DEPTH = 4;

/** 已提升为 yaml 顶层字段的 ST 条目字段，不再重复写进 `other`。 */
const CLEAN_SOURCE_KEYS = new Set([
    'uid',
    'comment',
    'content',
    'key',
    'keysecondary',
    'selectiveLogic',
    'constant',
    'vectorized',
    'disable',
    'excludeRecursion',
    'preventRecursion',
    'probability',
    'order',
    'position',
    'depth',
    'role',
    'caseSensitive',
    'extensions',
]);

/**
 * ST 条目 -> { yaml, md }。
 * @param {Record<string, any>} entry
 * @param {number|string} uidValue
 * @returns {{yaml: Record<string, any>, md: string}}
 */
export function entryToDoc(entry, uidValue) {
    const uid = Number(uidValue);
    if (!Number.isInteger(uid)) throw new Error(`非法 uid: ${uidValue}`);

    const position = normalizePositionName(entry.position);
    const mode = entry.constant ? 'always' : entry.vectorized ? 'vector' : 'keyword';

    /** @type {Record<string, any>} */
    const other = {};
    for (const [key, value] of Object.entries(entry)) {
        if (CLEAN_SOURCE_KEYS.has(key)) continue;
        if (value === undefined) continue;
        other[key] = value;
    }
    if (entry.extensions && typeof entry.extensions === 'object' && Object.keys(entry.extensions).length) {
        other.extensions = entry.extensions;
    }

    const yaml = {
        index: uid,
        name: String(entry.comment ?? ''),
        enabled: entry.disable !== true,
        activationMode: mode,
        key: toStringArray(entry.key),
        secondaryKey: toStringArray(entry.keysecondary),
        selectiveLogic: normalizeLogicName(entry.selectiveLogic),
        role: position === 'fixed' ? normalizeRoleName(entry.role) : null,
        caseSensitive: normalizeTriState(entry.caseSensitive),
        excludeRecursion: entry.excludeRecursion === true,
        preventRecursion: entry.preventRecursion === true,
        probability: toNumber(entry.probability, 100),
        position,
        order: toNumber(entry.order, DEFAULT_ORDER),
        depth: toNumber(entry.depth, DEFAULT_DEPTH),
        other,
    };

    return { yaml, md: String(entry.content ?? '') };
}

/**
 * { yaml, md } -> ST 条目。缺省/越界字段按 ST 默认值补齐，并给出警告。
 * @param {Record<string, any>} yaml
 * @param {string} md
 * @param {number|null} [fallbackUid] yaml 里没有合法 index 时使用的 uid
 * @returns {{entry: Record<string, any>, warnings: string[]}}
 */
export function docToEntry(yaml, md, fallbackUid = null) {
    if (!yaml || typeof yaml !== 'object' || Array.isArray(yaml)) {
        throw new Error('条目 yaml 必须是映射（key: value）');
    }

    /** @type {string[]} */
    const warnings = [];

    let uid = Number(yaml.index);
    if (!Number.isInteger(uid)) {
        if (Number.isInteger(fallbackUid)) {
            uid = Number(fallbackUid);
            warnings.push(`缺少合法的 index，已使用文件名中的 uid ${uid}`);
        } else {
            throw new Error('缺少合法的 index（必须是整数）');
        }
    }

    let mode = String(yaml.activationMode ?? 'keyword').trim();
    if (!ACTIVATION_MODES.includes(mode)) {
        warnings.push(`未知 activationMode "${mode}"，按 keyword 处理`);
        mode = 'keyword';
    }

    let positionName = String(yaml.position ?? 'beforeChar').trim();
    if (!POSITION_NAMES.includes(positionName)) {
        const mapped = normalizePositionName(positionName);
        warnings.push(`未知 position "${positionName}"，按 ${mapped} 处理`);
        positionName = mapped;
    }

    const positionIndex = POSITION_NAMES.indexOf(positionName);
    const logic = String(yaml.selectiveLogic ?? 'andAny').trim();
    if (!LOGIC_NAMES.includes(logic)) {
        warnings.push(`未知 selectiveLogic "${logic}"，按 andAny 处理`);
    }

    const other = yaml.other && typeof yaml.other === 'object' && !Array.isArray(yaml.other)
        ? structuredClone(yaml.other)
        : {};

    /** @type {Record<string, any>} */
    const entry = { ...other };
    delete entry.uid;

    entry.uid = uid;
    entry.comment = String(yaml.name ?? '');
    entry.content = String(md ?? '');
    entry.key = toStringArray(yaml.key);
    entry.keysecondary = toStringArray(yaml.secondaryKey);
    entry.selectiveLogic = logicIndex(logic);
    entry.constant = mode === 'always';
    entry.vectorized = mode === 'vector';
    entry.disable = yaml.enabled === false;
    entry.excludeRecursion = yaml.excludeRecursion === true;
    entry.preventRecursion = yaml.preventRecursion === true;
    entry.probability = clamp(toNumber(yaml.probability, 100), 0, 100);
    entry.order = toNumber(yaml.order, DEFAULT_ORDER);
    entry.depth = Math.max(0, toNumber(yaml.depth, DEFAULT_DEPTH));
    entry.position = positionIndex;
    entry.caseSensitive = normalizeTriState(yaml.caseSensitive);

    const role = normalizeRoleName(yaml.role);
    entry.role = positionIndex === POSITION_NAMES.indexOf('fixed') ? ROLE_NAMES.indexOf(role) : toNumber(entry.role, 0);

    if (!Object.hasOwn(entry, 'selective')) entry.selective = true;
    if (!Object.hasOwn(entry, 'useProbability')) entry.useProbability = true;
    if (!Object.hasOwn(entry, 'ignoreBudget')) entry.ignoreBudget = false;

    return { entry, warnings };
}

/**
 * 条目的文件名主干：`<uid>_<标题>`。
 * @param {number|string} uid
 * @param {string} name
 * @returns {string}
 */
export function entryBaseName(uid, name) {
    return `${Number(uid)}_${safeSegment(name) || 'entry'}`;
}

/**
 * 从文件名解析 uid（`12_标题.yaml` -> 12）。
 * @param {string} base
 * @returns {number|null}
 */
export function uidFromBaseName(base) {
    const match = /^(\d+)_/.exec(base);
    return match ? Number(match[1]) : null;
}

/**
 * 清洗成安全的单段名称（目录名 / 文件名）。保留中文与空格。
 * @param {string} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function safeSegment(value, maxLength = 80) {
    let text = String(value ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();

    text = text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

    if (text.length > maxLength) {
        text = text.slice(0, maxLength).trim();
    }
    return text;
}

/**
 * @param {any} value
 * @returns {number}
 */
function toNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function toStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(item => item !== null && item !== undefined).map(item => String(item));
}

/**
 * @param {any} value
 * @returns {boolean|null}
 */
function normalizeTriState(value) {
    if (value === true || value === false) return value;
    return null;
}

/**
 * @param {any} position
 * @returns {string}
 */
export function normalizePositionName(position) {
    if (typeof position === 'string') {
        if (POSITION_NAMES.includes(position)) return position;
        const legacy = position.trim().toLowerCase();
        if (legacy === 'before_char') return 'beforeChar';
        if (legacy === 'after_char') return 'afterChar';
        return 'beforeChar';
    }
    const index = Number(position);
    return POSITION_NAMES[index] ?? 'beforeChar';
}

/**
 * @param {any} logic
 * @returns {string}
 */
export function normalizeLogicName(logic) {
    if (typeof logic === 'string' && LOGIC_NAMES.includes(logic)) return logic;
    const index = Number(logic);
    return LOGIC_NAMES[index] ?? 'andAny';
}

/**
 * @param {string} name
 * @returns {number}
 */
export function logicIndex(name) {
    const index = LOGIC_NAMES.indexOf(String(name ?? '').trim());
    return index >= 0 ? index : 0;
}

/**
 * @param {any} role
 * @returns {string}
 */
export function normalizeRoleName(role) {
    if (typeof role === 'string') {
        const text = role.trim().toLowerCase();
        if (text === 'assistant' || text === 'model') return 'model';
        if (ROLE_NAMES.includes(text)) return text;
        const index = Number(role);
        if (Number.isInteger(index)) return ROLE_NAMES[index] ?? 'system';
        return 'system';
    }
    const index = Number(role);
    return ROLE_NAMES[index] ?? 'system';
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
