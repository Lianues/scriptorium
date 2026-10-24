/**
 * 给「工具调用」消息加一个直接可见的删除按钮。
 *
 * 背景：这类消息是 ST 的 ToolManager 生成的 smallSysMes（class 带 toolCall）。
 * ST 有一条 CSS：
 *
 *   .mes.smallSysMes:not(:has(.edit_textarea)) .ch_name { display: none; }
 *
 * 而 `.mes_buttons`（复制 / 编辑 / 书签）正好在 `.ch_name` 里面 ——
 * 于是工具消息上**一个按钮都没有**，连进编辑模式删除的入口都摸不到。
 *
 * 做法：把按钮挂到 `.mes` 元素本身（`.ch_name` 之外），绝对定位在右上角，
 * 不依赖 ST 的按钮行；点击后走 SillyTavern 自己的 deleteMessage
 * （带确认框、会同步 chat 数组和存档）。
 */

const MARKER = 'sc-has-tool-delete';
const BUTTON_CLASS = 'sc-tool-delete';

export class ToolMessageActions {
    /**
     * @param {any} context getContext()（可以是 Proxy）
     */
    constructor(context) {
        this.context = context;
        /** @type {MutationObserver|null} */
        this.observer = null;
        this.onClick = this.onClick.bind(this);
    }

    /**
     * @returns {void}
     */
    install() {
        this.decorateAll();

        const chat = document.getElementById('chat');
        if (!(chat instanceof HTMLElement)) {
            return;
        }

        this.observer = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.nodeType === 1) this.decorate(/** @type {HTMLElement} */ (node));
                }
            }
        });
        this.observer.observe(chat, { childList: true, subtree: true });
    }

    /**
     * @returns {void}
     */
    destroy() {
        this.observer?.disconnect();
        this.observer = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach(button => button.remove());
        document.querySelectorAll(`.${MARKER}`).forEach(element => element.classList.remove(MARKER));
    }

    /**
     * @returns {void}
     */
    decorateAll() {
        document.querySelectorAll('#chat .mes.toolCall').forEach(element => {
            if (element instanceof HTMLElement) this.decorate(element);
        });
    }

    /**
     * @param {HTMLElement} node
     * @returns {void}
     */
    decorate(node) {
        if (node.classList.contains('mes') && node.classList.contains('toolCall')) {
            this.addButton(node);
        }
        node.querySelectorAll?.('.mes.toolCall').forEach(element => {
            if (element instanceof HTMLElement) this.addButton(element);
        });
    }

    /**
     * @param {HTMLElement} element 单个 .mes.toolCall
     * @returns {void}
     */
    addButton(element) {
        if (element.classList.contains(MARKER)) return;

        element.classList.add(MARKER);

        const button = document.createElement('div');
        button.className = `${BUTTON_CLASS} fa-solid fa-trash-can interactable`;
        button.title = '删除这条工具调用消息';
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        button.dataset.scToolDelete = '1';

        // 内联兜底：样式表没加载时也不至于变成一个裸图标挤在消息末尾
        Object.assign(button.style, {
            position: 'absolute',
            top: '4px',
            right: '6px',
            width: '24px',
            height: '24px',
            display: 'grid',
            placeItems: 'center',
            borderRadius: '4px',
            background: 'rgba(0, 0, 0, 0.18)',
            fontSize: '13px',
            cursor: 'pointer',
            zIndex: '6',
        });

        button.addEventListener('click', this.onClick);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.onClick(event);
            }
        });

        // 关键：挂在 .mes 上，不能放进 .ch_name 里的 .mes_buttons（那里被 display:none 了）
        element.append(button);
    }

    /**
     * @param {Event} event
     * @returns {Promise<void>}
     */
    async onClick(event) {
        event.preventDefault();
        event.stopPropagation();

        const button = /** @type {HTMLElement} */ (event.currentTarget);
        const message = button.closest('.mes');
        if (!(message instanceof HTMLElement)) return;

        const mesid = Number(message.getAttribute('mesid'));
        if (!Number.isInteger(mesid) || mesid < 0) return;

        if (document.body.dataset.generating === 'true') {
            toastr.info('正在生成中，等这一轮结束再删。', '工作区');
            return;
        }

        try {
            // 第三参数 true = 用酒馆自己的确认弹窗；第四参数 false = 不再连带删除前置工具消息
            await this.context.deleteMessage(mesid, undefined, true, false);
        } catch (error) {
            console.error('[scriptorium] 删除工具消息失败', error);
            toastr.error(error?.message ?? String(error), '工作区');
        }
    }
}
