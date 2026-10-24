/**
 * 插件里跨模块共用的常量。
 */

/** 旧版：没有启用世界书时自建的目录书（现在只用于升级清理） */
export const DIRECTORY_BOOK = 'Scriptorium';

/** 旧版目录条目的标题，用来识别「这条是插件写的」 */
export const DIRECTORY_COMMENT = '世界书目录（Scriptorium 自动生成）';

/**
 * 虚拟目录条目：只在世界书扫描时塞进 globalLore，不落盘。
 * world + uid 是酒馆内部去重用的键，取一个不会和真实世界书撞上的值。
 */
export const DIRECTORY_WORLD = 'Scriptorium·目录';
export const DIRECTORY_UID = 900_000_001;

/**
 * 酒馆按 order 倒序排好后逐个 unshift 进 World Info (before)，
 * 所以 order 越小越靠前；压到极低就固定在开头。
 */
export const DIRECTORY_ORDER = -1_000_000_000;
