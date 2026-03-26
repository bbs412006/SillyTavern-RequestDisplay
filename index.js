/**
 * SillyTavern Request Display Extension
 * 悬浮状态条：全局网络雷达版
 */

import { eventSource, event_types } from '../../../events.js';
import { getGeneratingApi, getGeneratingModel, saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';

const extensionName = 'request-display';
const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const defaultSettings = {
    enabled: true,
    isMini: false,
    maxHistory: 20,
    position: { x: null, y: null },
};

// ===== 新架构：统一请求监控 =====
const monitor = {
    active: new Map(),
    currentVisibleId: null,
    history: [],
    timer: null,
    historyOpen: false,

    addRequest(req) {
        req.id = req.id || (Date.now() + Math.random().toString(36).substr(2, 9));
        req.startTime = Date.now();
        req.status = 'loading';
        this.active.set(req.id, req);
        this.updateView();
        return req.id;
    },

    finishRequest(id, status) {
        const req = this.active.get(id);
        if (!req) return;
        
        req.status = status; // 'done' | 'stopped'
        req.endTime = Date.now();
        req.elapsed = ((req.endTime - req.startTime) / 1000).toFixed(1);

        this.addHistory(req);

        if (this.currentVisibleId === id) {
            updateBarUI(req);
            setTimeout(() => {
                this.active.delete(id);
                if (this.currentVisibleId === id) this.currentVisibleId = null;
                this.updateView();
            }, 1000);
        } else {
            this.active.delete(id);
            this.updateView();
        }
    },

    updateView() {
        if (!getSettings()?.enabled || !$bar) return;

        let curReq = this.currentVisibleId ? this.active.get(this.currentVisibleId) : null;
        let bestReq = null;

        for (let req of this.active.values()) {
            if (req.status !== 'loading') continue;
            if (req.type === 'generation') {
                bestReq = req;
                break;
            }
            if (!bestReq || req.startTime > bestReq.startTime) {
                bestReq = req;
            }
        }

        if (bestReq) {
            this.currentVisibleId = bestReq.id;
            updateBarUI(bestReq);
            this.startTimer();
        } else if (!curReq || curReq.status !== 'loading') {
            this.stopTimer();
            renderIdleState();
        }
    },

    startTimer() {
        this.stopTimer();
        this.timer = setInterval(() => {
            const req = this.active.get(this.currentVisibleId);
            if (req && req.status === 'loading') {
                const el = ((Date.now() - req.startTime) / 1000).toFixed(1);
                const $time = $('.req-bar__time_loading');
                if ($time.length) $time.text(el + 's');
            }
        }, 100);
    },

    stopTimer() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    },

    addHistory(req) {
        const settings = getSettings();
        this.history.unshift(Object.assign({}, req));
        if (this.history.length > settings.maxHistory) {
            this.history = this.history.slice(0, settings.maxHistory);
        }
        renderHistory();
    }
};

let $wrapper, $bar, $icon, $text, $toggle, $history;

// ===== 初始化 =====
jQuery(async () => {
    loadSettings();
    await createUI();
    registerEventListeners();
    installGlobalInterceptors();
    await setupSettingsUI();
    toastr.info(`[Request Display] 插件已就绪`, null, { timeOut: 3000 });
    console.log(`[${extensionName}] 全局拦截器启动`);
});

// ===== 核心拦截器 =====
function filterAndParseUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let path = url;
    try {
        if (url.startsWith('http')) path = new URL(url).pathname;
    } catch(e) {}
    
    // 过滤掉前端静态资源等
    if (path.match(/\.(png|jpg|jpeg|gif|webp|svg|css|js|html|woff|woff2|ttf|json|mp3|wav)$/i)) return null;
    if (path.includes('/assets/') || path.includes('/css/') || path.includes('/img/') || path.includes('/scripts/')) return null;
    
    let apiName = "API";
    let modelName = path;
    
    if (path.startsWith('/api/')) {
        const parts = path.split('/').filter(Boolean);
        if (parts.length > 1) {
            apiName = "API";
            modelName = parts.slice(1).join('/'); // /api/openai/models -> openai/models
        }
    } else if (url.startsWith('http')) {
        apiName = "外部请求";
        try {
            modelName = new URL(url).hostname;
        } catch(e) {}
    } else {
        return null;
    }
    
    if (modelName.length > 25) modelName = modelName.substring(0, 22) + '...';
    
    return { api: apiName, model: modelName };
}

function installGlobalInterceptors() {
    // 1. 劫持原生 Fetch
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const parsed = filterAndParseUrl(url);
        let reqId = null;
        
        if (parsed) {
            reqId = monitor.addRequest({
                type: 'network',
                api: parsed.api,
                model: parsed.model,
                tokens: '后台',
                summary: 'Fetch 请求'
            });
        }
        
        try {
            const response = await originalFetch.apply(this, args);
            // 对于 /generate 这类的请求，我们通常在 eventSource 听到了，但这里一并显示
            if (reqId) monitor.finishRequest(reqId, response.ok ? 'done' : 'stopped');
            return response;
        } catch (e) {
            if (reqId) monitor.finishRequest(reqId, 'stopped');
            throw e;
        }
    };

    // 2. 劫持 jQuery AJAX
    $(document).ajaxSend((event, jqXHR, ajaxOptions) => {
        const parsed = filterAndParseUrl(ajaxOptions.url);
        if (parsed) {
            const reqId = monitor.addRequest({
                type: 'network',
                api: parsed.api,
                model: parsed.model,
                tokens: '后台',
                summary: 'AJAX 请求'
            });
            jqXHR.reqDisplayId = reqId;
        }
    });

    $(document).ajaxComplete((event, jqXHR, ajaxOptions) => {
        if (jqXHR.reqDisplayId) monitor.finishRequest(jqXHR.reqDisplayId, 'done');
    });

    $(document).ajaxError((event, jqXHR, ajaxOptions) => {
        if (jqXHR.reqDisplayId) monitor.finishRequest(jqXHR.reqDisplayId, 'stopped');
    });
}

// ===== 设置 UI =====
async function setupSettingsUI() {
    try {
        const html = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(html);

        const $enabledElem = $('#req_display_enabled');
        const $miniElem = $('#req_display_mini');
        const $resetBtn = $('#req_display_reset_pos');

        const settings = getSettings();
        $enabledElem.prop('checked', settings.enabled);
        if ($miniElem.length) $miniElem.prop('checked', settings.isMini);

        $enabledElem.on('change', () => {
            const val = $enabledElem.prop('checked');
            settings.enabled = val;
            saveSettings();
            if (val) {
                $wrapper.show();
                monitor.updateView();
            } else {
                $wrapper.hide();
            }
        });

        $miniElem.on('change', () => {
            const val = $miniElem.prop('checked');
            if (settings.isMini !== val) {
                toggleMiniMode();
            }
        });

        $resetBtn.on('click', () => {
            settings.position = { x: null, y: null };
            saveSettings();
            $wrapper.css({
                left: '0',
                right: '0',
                margin: '0 auto',
                top: '60px',
                bottom: 'auto',
                transform: 'none',
            });
            $wrapper.show();
            $bar.removeClass('req-bar--mini');
            settings.enabled = true;
            settings.isMini = false;
            $enabledElem.prop('checked', true);
            $miniElem.prop('checked', false);
            toastr.success('悬浮条位置已重置到屏幕上方中央');
        });
    } catch (e) {
        console.error(`[${extensionName}] Failed to load settings.html`, e);
    }
}

function loadSettings() {
    const context = getContext();
    if (!context.extensionSettings) context.extensionSettings = {};
    if (!context.extensionSettings[extensionName]) {
        context.extensionSettings[extensionName] = structuredClone(defaultSettings);
    }
    const settings = context.extensionSettings[extensionName];
    for (const [key, val] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) settings[key] = val;
    }
}

function getSettings() {
    return getContext().extensionSettings[extensionName];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ===== 创建 DOM =====
function createUI() {
    const settings = getSettings();

    $wrapper = $('<div>', { class: 'req-display-wrapper', id: 'req-display-wrapper' });
    $bar = $('<div>', { class: 'req-bar req-bar--idle' });
    if (settings.isMini) $bar.addClass('req-bar--mini');

    $icon = $('<div>', { class: 'req-bar__icon', text: '─' });
    const $content = $('<div>', { class: 'req-bar__content' });
    $text = $('<div>', { class: 'req-bar__text' }).html('<span style="color:#6b7280">等待请求...</span>');
    $toggle = $('<div>', { class: 'req-bar__toggle', text: '▼' });

    $content.append($text);
    $bar.append($icon, $content, $toggle);

    $history = $('<div>', { class: 'req-history' }).html(
        '<div class="req-history__empty">暂无历史记录</div>'
    );

    $wrapper.append($bar, $history);
    $('body').append($wrapper);

    if (!settings.enabled) {
        $wrapper.hide();
    }

    if (settings.position.x !== null && settings.position.y !== null) {
        $wrapper.css({
            left: settings.position.x + 'px',
            bottom: 'auto',
            top: settings.position.y + 'px',
            transform: 'none',
        });
        setTimeout(enforceBounds, 100);
    }

    $(window).on('resize', () => {
        if (settings.position.x !== null) enforceBounds();
    });

    $bar.on('click', (e) => {
        if ($(e.target).closest('.req-bar__toggle, .req-history').length) return;
        $bar.toggleClass('req-bar--mini');
        settings.isMini = $bar.hasClass('req-bar--mini');
        saveSettings();
        const $miniElem = $('#req_display_mini');
        if ($miniElem.length) $miniElem.prop('checked', settings.isMini);
    });

    $toggle.on('click', (e) => {
        e.stopPropagation();
        toggleHistoryPanel();
    });

    initDrag();
}

function toggleMiniMode() {
    const settings = getSettings();
    settings.isMini = !settings.isMini;
    saveSettings();

    if (settings.isMini) {
        $bar.addClass('req-bar--mini');
        if (monitor.historyOpen) {
            monitor.historyOpen = false;
            $wrapper.removeClass('req-display--open');
            $toggle.text('▼');
        }
    } else {
        $bar.removeClass('req-bar--mini');
    }
}

function toggleHistoryPanel() {
    const settings = getSettings();
    if (settings.isMini) return;

    monitor.historyOpen = !monitor.historyOpen;
    $wrapper.toggleClass('req-display--open', monitor.historyOpen);
    $toggle.text(monitor.historyOpen ? '▲' : '▼');
}

// ===== UI 渲染 =====
function renderIdleState() {
    if (!$bar) return;
    $bar.removeClass('req-bar--loading req-bar--done req-bar--stopped').addClass('req-bar--idle');
    $icon.text('─');
    $text.html('<span style="color:#6b7280">等待请求...</span>');
}

function updateBarUI(req) {
    if (!$bar) return;

    const statusClass = {
        loading: 'req-bar--loading',
        done: 'req-bar--done',
        stopped: 'req-bar--stopped',
    }[req.status] || 'req-bar--idle';

    $bar.removeClass('req-bar--idle req-bar--loading req-bar--done req-bar--stopped')
        .addClass(statusClass);

    const icons = { loading: '⟳', done: '✓', stopped: '⏹' };
    $icon.text(icons[req.status] || '─');

    const summaryText = req.summary
        ? `<span class="req-bar__summary">${escHtml(req.summary)}${req.summary.length > 20 ? '...' : ''}</span><span class="req-bar__sep">│</span>`
        : '';

    const tokensText = req.tokens !== undefined
        ? `<span class="req-bar__tokens">${req.tokens === '后台' ? '[后台]' : '~'+req.tokens.toLocaleString()+' tk'}</span><span class="req-bar__sep">│</span>`
        : '';

    let timeText = '';
    if (req.status === 'loading') {
        timeText = `<span class="req-bar__time_loading" style="color:#a78bfa">...</span>`;
    } else if (req.status === 'done') {
        timeText = `<span class="req-bar__time">${req.elapsed}s</span>`;
    } else if (req.status === 'stopped') {
        timeText = `<span style="color:#fb923c">${req.elapsed}s</span>`;
    }

    $text.html(`
        <span class="req-bar__api">${escHtml(req.api)}</span>
        <span class="req-bar__sep">│</span>
        <span class="req-bar__model">${escHtml(req.model)}</span>
        <span class="req-bar__sep">│</span>
        ${summaryText}
        ${tokensText}
        ${timeText}
    `);
}

function renderHistory() {
    if (monitor.history.length === 0) {
        $history.html('<div class="req-history__empty">暂无历史记录</div>');
        return;
    }

    const html = monitor.history.map((h, i) => `
        <div class="req-history__item">
            <span class="req-history__idx">#${i + 1}</span>
            <span class="req-history__api">${escHtml(h.api)}</span>
            <span class="req-history__model" style="margin-left:8px">${escHtml(h.model)}</span>
            <span class="req-history__spacer"></span>
            <span class="req-history__tokens">${h.tokens !== undefined ? (h.tokens === '后台' ? '后台' : h.tokens.toLocaleString() + ' tk') : '—'}</span>
            <span class="req-history__time${h.status==='stopped' ? ' req-history__time--stopped' : ''}">${h.elapsed}s${h.status==='stopped' ? ' ⏹' : ''}</span>
        </div>
    `).join('');
    $history.html(html);
}

// ===== 生成事件监听 =====
function registerEventListeners() {
    let genReqId = null;

    eventSource.on(event_types.GENERATION_STARTED, (type, _params, isDryRun) => {
        if (isDryRun || !getSettings().enabled) return;
        genReqId = monitor.addRequest({
            type: 'generation',
            api: getGeneratingApi() || 'Chat',
            model: getGeneratingModel() || '',
            tokens: 0,
            summary: ''
        });
    });

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (eventData) => {
        if (!getSettings().enabled || eventData.dryRun || !genReqId) return;
        
        try {
            const chat = eventData.chat;
            if (!Array.isArray(chat) || chat.length === 0) return;
            
            const userMsgs = chat.filter(m => m.role === 'user');
            if (userMsgs.length > 0) {
                const lastUserMsg = userMsgs[userMsgs.length - 1];
                let content = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
                if (Array.isArray(lastUserMsg.content)) {
                    content = lastUserMsg.content.find(p => p.type === 'text')?.text || '';
                }
                const req = monitor.active.get(genReqId);
                if (req) {
                    req.summary = content.slice(0, 30).replace(/\n/g, ' ');
                    monitor.updateView();
                }
            }

            const fullText = chat.map(m => {
                if (typeof m.content === 'string') return m.content;
                if (Array.isArray(m.content)) return m.content.filter(p => p.type === 'text').map(p => p.text).join('');
                return '';
            }).join('\n');

            const req = monitor.active.get(genReqId);
            if (req) {
                try {
                    req.tokens = await getTokenCountAsync(fullText);
                } catch {
                    req.tokens = Math.round(fullText.length / 2);
                }
                monitor.updateView();
            }
        } catch (e) {
            console.warn(`[${extensionName}] 捕获 prompt 失败:`, e);
        }
    });

    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (!getSettings().enabled || !genReqId) return;
        monitor.finishRequest(genReqId, 'done');
        genReqId = null;
    });

    eventSource.on(event_types.GENERATION_STOPPED, () => {
        if (!getSettings().enabled || !genReqId) return;
        monitor.finishRequest(genReqId, 'stopped');
        genReqId = null;
    });
}

// ===== 拖拽与边界 =====
function initDrag() {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    $bar.on('mousedown touchstart', (e) => {
        if ($(e.target).closest('.req-bar__toggle').length) return;

        const touch = e.type === 'touchstart' ? e.originalEvent.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;

        const rect = $wrapper[0].getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        isDragging = false;

        const onMove = (moveE) => {
            const mt = moveE.type === 'touchmove' ? moveE.originalEvent.touches[0] : moveE;
            const dx = mt.clientX - startX;
            const dy = mt.clientY - startY;

            if (!isDragging && Math.abs(dx) + Math.abs(dy) < 5) return;
            isDragging = true;
            $wrapper.addClass('req-display--dragging');

            $wrapper.css({
                left: (startLeft + dx) + 'px',
                top: (startTop + dy) + 'px',
                bottom: 'auto',
                transform: 'none',
            });
        };

        const onUp = () => {
            $(document).off('mousemove touchmove', onMove);
            $(document).off('mouseup touchend', onUp);
            $wrapper.removeClass('req-display--dragging');

            if (isDragging) {
                const settings = getSettings();
                const rect = $wrapper[0].getBoundingClientRect();
                settings.position.x = rect.left;
                settings.position.y = rect.top;
                saveSettings();
                enforceBounds();
            }
        };

        $(document).on('mousemove touchmove', onMove);
        $(document).on('mouseup touchend', onUp);
    });
}

function enforceBounds() {
    if (!$wrapper) return;
    const settings = getSettings();
    if (settings.position.x === null) return;

    const rect = $wrapper[0].getBoundingClientRect();
    const ww = window.innerWidth;
    const wh = window.innerHeight;

    let newX = settings.position.x;
    let newY = settings.position.y;
    let changed = false;

    if (newX + rect.width > ww) { newX = ww - rect.width - 10; changed = true; }
    if (newY + rect.height > wh) { newY = wh - rect.height - 10; changed = true; }
    if (newX < 10) { newX = 10; changed = true; }
    if (newY < 10) { newY = 10; changed = true; }

    if (changed) {
        settings.position.x = newX;
        settings.position.y = newY;
        $wrapper.css({ left: newX + 'px', top: newY + 'px' });
        saveSettings();
    }
}

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
