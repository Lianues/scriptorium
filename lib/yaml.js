/**
 * YAML 读写适配层。
 *
 * 用 SillyTavern 自带的 `yaml`（package.json 里的 yaml@2，`public/lib.js` 已经导出），
 * 不自己造解析器：解析行为、报错信息、缩进风格都跟酒馆服务端读世界书时一致。
 *
 * 为什么做成"注入"而不是直接 `import { yaml } from '../../../../../lib.js'`：
 *   - 单测在纯 Node 下跑，没有 webpack 出来的 /lib.js；
 *   - 注入之后测试可以直接用同一个 yaml 包（同一版本），测的还是真解析器。
 *
 * 初始化：index.js 顶部 `setYamlImplementation(yaml)`。
 */

/** @type {{parse: Function, stringify: Function} | null} */
let implementation = null;

const DUMP_OPTIONS = {
    // 不按宽度折行：条目配置里有长 description，折行会让 diff 变得难读
    lineWidth: 0,
};

/**
 * @param {{parse: Function, stringify: Function}} yaml
 * @returns {void}
 */
export function setYamlImplementation(yaml) {
    if (!yaml || typeof yaml.parse !== 'function' || typeof yaml.stringify !== 'function') {
        throw new Error('yaml 实现无效：需要 parse / stringify');
    }
    implementation = yaml;
}

/**
 * @returns {boolean}
 */
export function isYamlReady() {
    return implementation !== null;
}

/**
 * @returns {{parse: Function, stringify: Function}}
 */
export function getYaml() {
    if (!implementation) {
        throw new Error('YAML 解析器未初始化：index.js 里应该调用 setYamlImplementation(yaml)');
    }
    return implementation;
}

/**
 * 解析成普通对象。空文本返回 `{}`，根节点必须是映射。
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseYaml(text) {
    const source = String(text ?? '');
    if (!source.trim()) return {};

    const value = getYaml().parse(source);
    if (value === null || value === undefined) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('YAML 根节点必须是映射（key: value）');
    }
    return value;
}

/**
 * 序列化成 YAML 文本。
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function dumpYaml(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('dumpYaml 只接受对象作为根节点');
    }
    return getYaml().stringify(value, DUMP_OPTIONS);
}
