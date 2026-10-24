/**
 * 工具调用链的折叠。
 *
 * 场景：一次生成里模型可能连续调好几次工具，聊天里会留下
 *   [assistant 正文] / [系统·工具调用] / [assistant 正文] / [系统·工具调用] …
 * 最后才是真正的回答。这些中间消息在回答出来之后就没必要占屏幕了。
 *
 * 做法（纯前端，不动 chat 数组）：
 *   - 找出"最后一条用户消息"到"最后一个工具调用消息"之间的所有消息；
 *   - 给它们加 `.sc-chain-collapsed`（display:none）；
 *   - 在最终回答那条消息里插入一个胶囊按钮，点击展开/收起。
 *
 * 判定条件：最后一条消息必须是普通 assistant（不是工具调用、不是用户/系统），
 * 否则说明链还没走完，先不折叠。
 *
 * 连带删除：折叠着的链，最后正文被整条删掉（连同所有分支）时，把被折叠的中间消息也删掉。
 *   - 每次 apply 记下折叠链的消息对象引用；收到 MESSAGE_DELETED 时，正文对象已不在
 *     chat 里、中间消息还在，就是「整条删了」。
 *   - 切换 / 新建 / 删除单个分支都只改同一个消息对象的 swipes，对象还在，不会触发。
 *   - 重新生成会先删掉最后一条再生成：GENERATION_STARTED 先于删除，届时清空记录，不动过程消息。
 *   - 用户手动展开的链不算「折叠着」，不连带删除。
 *
 * 注意：MutationObserver 盯着整个 #chat，胶囊自己也在 #chat 里。apply 必须幂等
 * （内容没变就不碰 DOM），observer 也要忽略只涉及胶囊的变化 —— 否则改胶囊 →
 * 触发 observer → 再 apply → 再改胶囊，每 120ms 重建一次，按下时的节点在松开前
 * 被换掉，click 就丢了。
 */

const CHIP_CLASS = 'sc-chain-chip';
const COLLAPSED_CLASS = 'sc-chain-collapsed';
const DEBOUNCE_MS = 120;
/** 只触发重新计算的事件；MESSAGE_DELETED 单独处理（要先连带删除） */
const REFRESH_EVENTS = ['GENERATION_ENDED', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED'];
/**
 * 正文已经不在 chat 里、但还没等到 MESSAGE_DELETED 的链，最多再记这么久。
 * 删除模式下酒馆先 await 保存再发事件，apply 可能抢先跑掉；超时就当作不是删除造成的。
 */
const LOST_TTL_MS = 10_000;

export class ToolChainCollapse {
    /**
     * @param {any} context getContext()（可以是 Proxy）
     */
    constructor(context) {
        this.context = context;
        /** @type {Set<string>} 用户手动展开过的链 */
        this.expanded = new Set();
        /** @type {any} */
        this.timer = null;
        /** @type {MutationObserver|null} */
        this.observer = null;
        /**
         * 上次 apply 时折叠着的链（存消息对象，不存下标：删除后下标会变）。
         * @type {{final: any, intermediate: any[], lostAt: number}[]}
         */
        this.tracked = [];
        /** 正在连带删除：自己调 deleteMessage 也会发 MESSAGE_DELETED */
        this.cascading = false;

        this.schedule = this.schedule.bind(this);
        this.apply = this.apply.bind(this);
        this.onChatChanged = this.onChatChanged.bind(this);
        this.onMessageDeleted = this.onMessageDeleted.bind(this);
        this.onGenerationStarted = this.onGenerationStarted.bind(this);
    }

    /**
     * @returns {void}
     */
    install() {
        const ctx = this.context;
        const events = ctx?.eventTypes ?? {};
        const source = ctx?.eventSource;

        for (const name of REFRESH_EVENTS) {
            const type = events[name];
            if (type) source?.on?.(type, this.schedule);
        }
        if (events.CHAT_CHANGED) source?.on?.(events.CHAT_CHANGED, this.onChatChanged);
        if (events.MESSAGE_DELETED) source?.on?.(events.MESSAGE_DELETED, this.onMessageDeleted);
        if (events.GENERATION_STARTED) source?.on?.(events.GENERATION_STARTED, this.onGenerationStarted);

        const chat = document.getElementById('chat');
        if (chat instanceof HTMLElement) {
            this.observer = new MutationObserver(records => {
                if (records.some(record => !isOwnMutation(record))) this.schedule();
            });
            this.observer.observe(chat, { childList: true, subtree: true });
        }

        this.schedule();
    }

    /**
     * @returns {void}
     */
    destroy() {
        this.observer?.disconnect();
        this.observer = null;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        const ctx = this.context;
        const events = ctx?.eventTypes ?? {};
        const source = ctx?.eventSource;
        if (typeof source?.removeListener === 'function') {
            for (const name of REFRESH_EVENTS) {
                const type = events[name];
                if (type) source.removeListener(type, this.schedule);
            }
            if (events.CHAT_CHANGED) source.removeListener(events.CHAT_CHANGED, this.onChatChanged);
            if (events.MESSAGE_DELETED) source.removeListener(events.MESSAGE_DELETED, this.onMessageDeleted);
            if (events.GENERATION_STARTED) source.removeListener(events.GENERATION_STARTED, this.onGenerationStarted);
        }

        this.tracked = [];
        this.clearDom();
    }

    /**
     * @returns {void}
     */
    onChatChanged() {
        this.expanded.clear();
        this.tracked = [];
        this.clearDom();
        this.schedule();
    }

    /**
     * 生成开始：重新生成会先删掉最后正文，那属于「换个回答」，不能连带删过程消息。
     * dryRun（算 token / 预览提示词）和 quiet（后台生成）不会删消息，不用管。
     * @param {string} type
     * @param {any} _options
     * @param {boolean} dryRun
     * @returns {void}
     */
    onGenerationStarted(type, _options, dryRun) {
        if (dryRun || type === 'quiet') return;
        this.tracked = [];
    }

    /**
     * @returns {void}
     */
    onMessageDeleted() {
        if (this.cascading) return;
        void this.cascadeDelete();
        this.schedule();
    }

    /**
     * 最后正文被整条删掉的折叠链：把还留着的中间消息一起删掉。
     * @returns {Promise<void>}
     */
    async cascadeDelete() {
        const ctx = this.context;
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
        if (!chat || typeof ctx?.deleteMessage !== 'function') return;

        if (document.body?.dataset?.generating === 'true') {
            this.tracked = [];
            return;
        }

        const now = Date.now();
        const lost = this.tracked.filter(item => !chat.includes(item.final) && (!item.lostAt || now - item.lostAt < LOST_TTL_MS));
        this.tracked = this.tracked.filter(item => chat.includes(item.final));

        const targets = lost.flatMap(item => item.intermediate).filter(message => chat.includes(message));
        if (!targets.length) return;

        // 从后往前删，前面的下标不受影响；每次都按对象重新找下标，不信任旧值
        targets.sort((a, b) => chat.indexOf(b) - chat.indexOf(a));

        this.cascading = true;
        let removed = 0;
        try {
            for (const message of targets) {
                const id = chat.indexOf(message);
                if (id < 0) continue;
                // 不确认（用户已经确认过删正文）；第四参数 false = 只删这一条，别让酒馆再往前连带
                await ctx.deleteMessage(id, undefined, false, false);
                if (!chat.includes(message)) removed += 1;
            }
        } catch (error) {
            console.error('[scriptorium] 连带删除折叠消息失败', error);
            globalThis.toastr?.error?.(error?.message ?? String(error), 'Scriptorium');
        } finally {
            this.cascading = false;
        }

        if (removed) {
            globalThis.toastr?.info?.(`已连带删除 ${removed} 条折叠的中间消息`, 'Scriptorium');
        }
        this.schedule();
    }

    /**
     * 合并短时间内的多次触发（流式输出时 DOM 变化非常频繁）。
     * @returns {void}
     */
    schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.apply();
        }, DEBOUNCE_MS);
    }

    /**
     * 计算并应用折叠状态（整段聊天里所有"已完成"的工具链都折叠）。
     * @returns {void}
     */
    apply() {
        const ctx = this.context;
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
        if (!chat || chat.length === 0) {
            if (chat) this.track(chat, []);
            this.clearDom();
            return;
        }

        // 生成过程中不动：等这一轮结束再折叠
        if (document.body?.dataset?.generating === 'true') return;

        const chains = this.collectChains(chat);
        this.track(chat, chains);
        if (!chains.length) {
            this.clearDom();
            return;
        }

        // 清掉不再属于任何链的胶囊
        const activeKeys = new Set(chains.map(chain => chain.key));
        document.querySelectorAll(`#chat .${CHIP_CLASS}`).forEach(chip => {
            if (chip instanceof HTMLElement && !activeKeys.has(chip.dataset.chain ?? '')) chip.remove();
        });

        // 需要隐藏的消息：未展开的链的中间消息
        /** @type {Set<number>} */
        const shouldHide = new Set();
        for (const chain of chains) {
            if (this.expanded.has(chain.key)) continue;
            for (const id of chain.intermediate) shouldHide.add(id);
        }

        document.querySelectorAll(`#chat .mes.${COLLAPSED_CLASS}`).forEach(element => {
            if (!(element instanceof HTMLElement)) return;
            const id = Number(element.getAttribute('mesid'));
            if (!shouldHide.has(id)) {
                element.classList.remove(COLLAPSED_CLASS);
                element.style.removeProperty('display');   // 连内联兜底一起撤掉
            }
        });

        for (const id of shouldHide) {
            const element = this.findMessage(id);
            if (!element) continue;
            element.classList.add(COLLAPSED_CLASS);
            // 不依赖样式表：万一样式没加载，内联 display 也能保证真的折起来
            element.style.display = 'none';
        }

        for (const chain of chains) {
            const finalElement = this.findMessage(chain.final);
            if (!finalElement) continue;
            this.ensureChip(
                finalElement,
                chain.key,
                this.expanded.has(chain.key),
                chain.intermediate.length,
                chain.toolCount,
            );
        }
    }

    /**
     * 记下当前折叠着的链，供连带删除用。
     * 正文已经不在 chat 里的旧记录先留着（打上时间），等 MESSAGE_DELETED 来处理。
     * @param {any[]} chat
     * @param {{key: string, final: number, intermediate: number[]}[]} chains
     * @returns {void}
     */
    track(chat, chains) {
        const now = Date.now();
        const lost = this.tracked
            .filter(item => !chat.includes(item.final))
            .map(item => ({ ...item, lostAt: item.lostAt || now }))
            .filter(item => now - item.lostAt < LOST_TTL_MS);

        const collapsed = chains
            .filter(chain => !this.expanded.has(chain.key))
            .map(chain => ({
                final: chat[chain.final],
                intermediate: chain.intermediate.map(index => chat[index]),
                lostAt: 0,
            }));

        this.tracked = [...lost, ...collapsed];
    }

    /**
     * 把聊天按"用户消息"切成回合，找出每个回合里已完成的工具链。
     * @param {any[]} chat
     * @returns {{key: string, start: number, final: number, intermediate: number[], toolCount: number}[]}
     */
    collectChains(chat) {
        /** @type {{key: string, start: number, final: number, intermediate: number[], toolCount: number}[]} */
        const chains = [];
        const chatId = String(this.context?.getCurrentChatId?.() ?? '');
        let start = 0;

        for (let i = 0; i <= chat.length; i++) {
            const atEnd = i === chat.length;
            if (!atEnd && !chat[i]?.is_user) continue;

            const chain = this.buildChain(chat, start, i - 1, chatId);
            if (chain) chains.push(chain);
            start = i + 1;
        }

        return chains;
    }

    /**
     * @param {any[]} chat
     * @param {number} start
     * @param {number} end
     * @param {string} chatId
     * @returns {{key: string, start: number, final: number, intermediate: number[], toolCount: number}|null}
     */
    buildChain(chat, start, end, chatId) {
        if (end <= start) return null;

        let lastTool = -1;
        for (let i = end; i >= start; i--) {
            if (hasToolInvocations(chat[i])) {
                lastTool = i;
                break;
            }
        }

        // 没有工具调用，或最后一个消息还是工具调用（链还没走完）
        if (lastTool < 0 || lastTool === end) return null;

        const finalMessage = chat[end];
        if (!finalMessage || finalMessage.is_user || finalMessage.is_system) return null;

        /** @type {number[]} */
        const intermediate = [];
        for (let i = start; i <= lastTool; i++) {
            if (!chat[i]?.is_user) intermediate.push(i);
        }
        if (!intermediate.length) return null;

        return {
            key: `${chatId}:${start}:${lastTool}:${end}`,
            start,
            final: end,
            intermediate,
            toolCount: intermediate.filter(index => hasToolInvocations(chat[index])).length,
        };
    }

    /**
     * @param {number} mesid
     * @returns {HTMLElement|null}
     */
    findMessage(mesid) {
        const element = document.querySelector(`#chat .mes[mesid="${mesid}"]`);
        return element instanceof HTMLElement ? element : null;
    }

    /**
     * @param {HTMLElement} messageElement
     * @param {string} chainKey
     * @param {boolean} isExpanded
     * @param {number} count
     * @param {number} toolCount
     * @returns {void}
     */
    ensureChip(messageElement, chainKey, isExpanded, count, toolCount) {
        const block = messageElement.querySelector('.mes_block');
        if (!(block instanceof HTMLElement)) return;

        let chip = block.querySelector(`.${CHIP_CLASS}`);
        if (chip instanceof HTMLElement && chip.dataset.chain !== chainKey) {
            chip.remove();
            chip = null;
        }

        if (!(chip instanceof HTMLElement)) {
            chip = document.createElement('div');
            chip.className = CHIP_CLASS;
            chip.setAttribute('role', 'button');
            chip.tabIndex = 0;
            chip.dataset.chain = chainKey;

            const icon = document.createElement('span');
            icon.className = 'sc-chain-icon';
            const text = document.createElement('span');
            text.className = 'sc-chain-text';
            chip.append(icon, text);

            chip.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.toggle(chainKey);
            });
            chip.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.toggle(chainKey);
                }
            });

            const anchor = block.querySelector('.mes_text');
            if (anchor) block.insertBefore(chip, anchor);
            else block.append(chip);
        }

        // 只在真的变了时写 DOM：每次都重建子节点会让 observer 无限触发，点击也会丢
        chip.classList.toggle('is-expanded', isExpanded);
        const title = isExpanded ? '点击收起中间步骤' : '点击展开中间步骤';
        if (chip.title !== title) chip.title = title;

        setText(chip.querySelector('.sc-chain-icon'), isExpanded ? '▾' : '▸');
        setText(chip.querySelector('.sc-chain-text'), `${isExpanded ? '收起' : '已折叠'} ${count} 条中间消息 · ${toolCount} 次工具调用`);
    }

    /**
     * @param {string} chainKey
     * @returns {void}
     */
    toggle(chainKey) {
        if (this.expanded.has(chainKey)) this.expanded.delete(chainKey);
        else this.expanded.add(chainKey);
        this.apply();
    }

    /**
     * @returns {void}
     */
    clearDom() {
        document.querySelectorAll(`#chat .mes.${COLLAPSED_CLASS}`).forEach(element => {
            element.classList.remove(COLLAPSED_CLASS);
            if (element instanceof HTMLElement) {
                delete element.dataset.scChain;
                element.style.removeProperty('display');
            }
        });
        document.querySelectorAll(`#chat .${CHIP_CLASS}`).forEach(chip => chip.remove());
    }
}

/**
 * @param {Element|null} element
 * @param {string} value
 * @returns {void}
 */
function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
}

/**
 * 这条变化是不是只发生在胶囊上（胶囊内部改字 / 插入或移除胶囊本身）。
 * @param {MutationRecord} record
 * @returns {boolean}
 */
function isOwnMutation(record) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.closest(`.${CHIP_CLASS}`)) return true;

    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every(node => node instanceof HTMLElement && node.classList.contains(CHIP_CLASS));
}

/**
 * @param {any} message
 * @returns {boolean}
 */
function hasToolInvocations(message) {
    return Array.isArray(message?.extra?.tool_invocations) && message.extra.tool_invocations.length > 0;
}
