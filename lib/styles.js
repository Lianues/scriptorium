/**
 * 样式注入。
 *
 * 不依赖 manifest 的 css 字段：扩展装上是热重载的情况下，酒馆有时会拿着
 * 旧的 manifest（没有 css）去加载，样式就静默丢了 —— 胶囊在、折叠没生效。
 * 这里用 JS 直接插一个 <style>，稳。
 */

const STYLE_ID = 'sc-styles';

const CSS = `
/* 工具调用链折叠 */
.mes.sc-chain-collapsed {
    display: none !important;
}

.sc-chain-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 2px 0 6px;
    padding: 2px 9px;
    border: 1px dashed var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.25));
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.6;
    opacity: 0.65;
    cursor: pointer;
    user-select: none;
    width: fit-content;
}

.sc-chain-chip:hover {
    opacity: 1;
    border-color: var(--SmartThemeQuoteColor, #6ea8fe);
}

.sc-chain-chip.is-expanded {
    opacity: 0.85;
}

.sc-chain-icon {
    font-size: 9px;
    opacity: 0.8;
}

/* 工具调用消息上的删除按钮 */
.mes.toolCall {
    position: relative;
}

.mes.toolCall .mes_block {
    padding-right: 30px;
}

.sc-tool-delete {
    position: absolute;
    top: 4px;
    right: 6px;
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 4px;
    font-size: 13px;
    line-height: 1;
    color: var(--SmartThemeBodyColor, #ddd);
    background: rgba(0, 0, 0, 0.18);
    opacity: 0.55;
    cursor: pointer;
    z-index: 6;
    transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}

.mes.toolCall:hover .sc-tool-delete {
    opacity: 1;
}

.sc-tool-delete:hover {
    color: #e06c75;
    background: rgba(224, 108, 117, 0.22);
}
`;

/**
 * @returns {void}
 */
export function installStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
}
