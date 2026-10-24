/**
 * 单测用的 YAML 初始化。
 *
 * 插件本身用 SillyTavern 的 `/lib.js` 导出（webpack 把 npm 的 yaml 包打进去），
 * 纯 Node 环境没有那个文件，所以这里直接从 ST 的 node_modules 里拿同一个包（同版本）。
 *
 * 找不到就抛错，而不是静默跳过 —— YAML 是这个插件的核心路径，跳过的测试没有意义。
 * 换机器时可以用环境变量指定：
 *   ST_YAML_PATH=D:\SillyTavern\node_modules\yaml\dist\index.js
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isYamlReady, setYamlImplementation } from '../lib/yaml.js';

/** @type {string[]} */
const candidates = [
    process.env.ST_YAML_PATH,
    'E:/酒馆/SillyTavern/node_modules/yaml/dist/index.js',
    'F:/111/酒馆插件教程/SillyTavern-1.19.0/node_modules/yaml/dist/index.js',
].filter(Boolean);

for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    const module = await import(pathToFileURL(candidate).href);
    const yaml = module.default ?? module;
    setYamlImplementation(yaml);
    break;
}

if (!isYamlReady()) {
    throw new Error(
        '找不到 yaml 包。请设置 ST_YAML_PATH 指向 SillyTavern/node_modules/yaml/dist/index.js',
    );
}
