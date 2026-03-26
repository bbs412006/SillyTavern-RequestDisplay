/**
 * SillyTavern Request Display Extension
 * 悬浮状态条：显示当前最新请求的 API 来源、内容摘要、token 数量及请求状态
 */

import { eventSource, event_types } from '../../../events.js';
import { getGeneratingApi, getGeneratingModel, saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';

const extensionName = 'request-display';
// 动态获取当前脚本所在目录路径
const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

// ===== 默认设置 =====
const defaultSettings = {
    enabled: true,
    isMini: false,
    maxHistory: 20,
    position: { x: null, y: null }, // null = 底部居中
};

// ===== 状态 =====
let state = {
    status: 'idle',        // idle | loading | done | stopped
    api: '',
    model: '',
    summary: '',
    tokens: 0,
    startTime: null,
    elapsed: null,
    historyOpen: false,
    history: [],           // { api, model, summary, tokens, elapsed, stopped, timestamp }
    pendingPromptData: null,
};

// ===== DOM 引用 =====
let $wrapper, $bar, $icon, $text, $toggle, $history;

// ===== 初始化 =====
jQuery(async () => {
    loadSettings();
    await createUI();
    registerEventListeners();
    await setupSettingsUI();
    toastr.info(`[Request Display] 插件已就绪`, null, { timeOut: 3000 });
    console.log(`[${extensionName}] 插件已加载`);
});

// ===== 设置 UI 面板 =====
async function setupSettingsUI() {
    try {
        const html = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(html);

        const $enabledElem = $('#req_display_enabled');
        const $miniElem = $('#req_display_mini');
        const $resetBtn = $('#req_display_reset_pos');

        // 恢复当前值
        const settings = getSettings();
        $enabledElem.prop('checked', settings.enabled);
        $miniElem.prop('checked', settings.isMini);

        // 监听开关
        $enabledElem.on('change', () => {
            const val = $enabledElem.prop('checked');
            settings.enabled = val;
            saveSettings();
            if (val) {
                $wrapper.show();
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

        // 重置位置
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
            $wrapper.show(); // 确保显示
            $bar.removeClass('req-bar--mini');
            settings.enabled = true; // 强制启用
            settings.isMini = false;
            $enabledElem.prop('checked', true);
            $miniElem.prop('checked', false);
            toastr.success('悬浮条位置已重置到屏幕下方中央');
        });

    } catch (e) {
        console.error(`[${extensionName}] Failed to load settings.html`, e);
    }
}

// ===== 设置管理 =====
function loadSettings() {
    const context = getContext();
    if (!context.extensionSettings) context.extensionSettings = {};
    if (!context.extensionSettings[extensionName]) {
        context.extensionSettings[extensionName] = structuredClone(defaultSettings);
    }
    // 合并缺失字段
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

function createUI() {
    const settings = getSettings();

    // Wrapper
    $wrapper = $('<div>', { class: 'req-display-wrapper', id: 'req-display-wrapper' });

    // Bar
    $bar = $('<div>', { class: 'req-bar req-bar--idle' });
    if (settings.isMini) $bar.addClass('req-bar--mini');

    $icon = $('<div>', { class: 'req-bar__icon', text: '─' });
    const $content = $('<div>', { class: 'req-bar__content' });
    $text = $('<div>', { class: 'req-bar__text' }).html('<span style="color:#6b7280">等待请求...</span>');
    $toggle = $('<div>', { class: 'req-bar__toggle', text: '▼' });

    $content.append($text);
    $bar.append($icon, $content, $toggle);

    // History panel
    $history = $('<div>', { class: 'req-history' }).html(
        '<div class="req-history__empty">暂无历史记录</div>'
    );

    $wrapper.append($bar, $history);
    $('body').append($wrapper);

    // 如果未启用，则隐藏
    if (!settings.enabled) {
        $wrapper.hide();
    }

    // 恢复位置
    if (settings.position.x !== null && settings.position.y !== null) {
        $wrapper.css({
            left: settings.position.x + 'px',
            bottom: 'auto',
            top: settings.position.y + 'px',
            transform: 'none',
        });
        
        // 延时校验边界（等待 DOM 渲染完成拿到真实宽高）
        setTimeout(enforceBounds, 100);
    }

    // 监听窗口大小变化
    $(window).on('resize', () => {
        if (settings.position.x !== null) enforceBounds();
    });

    // 点击切换极简
    $bar.on('click', (e) => {
        if ($(e.target).closest('.req-bar__toggle, .req-history').length) return;
        // isDragging is not defined in this scope, assuming it's meant to be a global or passed.
        // For now, removing the !isDragging check as it's not available here.
        // If drag functionality is intended to prevent click, it needs to be handled differently.
        // Re-adding the original toggleMiniMode call, and adding saveSettings() there.
        // Or, if the instruction implies inlining the logic, we need to ensure $miniElem is accessible.
        // Given $miniElem is now global, we can inline.
        $bar.toggleClass('req-bar--mini');
        settings.isMini = $bar.hasClass('req-bar--mini');
        saveSettings();
        if ($miniElem) { // Ensure $miniElem is initialized
            $miniElem.prop('checked', settings.isMini);
        }
    });

    // 点击展开历史
    $toggle.on('click', (e) => {
        e.stopPropagation();
        toggleHistoryPanel();
    });

    // 拖拽
    initDrag();
}

// ===== 极简模式 =====
function toggleMiniMode() {
    const settings = getSettings();
    settings.isMini = !settings.isMini;
    saveSettings();

    if (settings.isMini) {
        $bar.addClass('req-bar--mini');
        // 收起历史
        if (state.historyOpen) {
            state.historyOpen = false;
            $wrapper.removeClass('req-display--open');
            $toggle.text('▼');
        }
    } else {
        $bar.removeClass('req-bar--mini');
    }
}

// ===== 历史面板 =====
function toggleHistoryPanel() {
    const settings = getSettings();
    if (settings.isMini) return;

    state.historyOpen = !state.historyOpen;
    $wrapper.toggleClass('req-display--open', state.historyOpen);
    $toggle.text(state.historyOpen ? '▲' : '▼');
}

function renderHistory() {
    if (state.history.length === 0) {
        $history.html('<div class="req-history__empty">暂无历史记录</div>');
        return;
    }

    const html = state.history.map((h, i) => `
        <div class="req-history__item">
            <span class="req-history__idx">#${i + 1}</span>
            <span class="req-history__api">${escHtml(h.api)}</span>
            <span class="req-history__model" style="margin-left:8px">${escHtml(h.model)}</span>
            <span class="req-history__spacer"></span>
            <span class="req-history__tokens">${h.tokens ? h.tokens.toLocaleString() + ' tk' : '—'}</span>
            <span class="req-history__time${h.stopped ? ' req-history__time--stopped' : ''}">${h.elapsed}s${h.stopped ? ' ⏹' : ''}</span>
        </div>
    `).join('');
    $history.html(html);
}

// ===== 拖拽 =====
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

        isDragging = false; // 先不标记，等超过阈值

        const onMove = (moveE) => {
            const mt = moveE.type === 'touchmove' ? moveE.originalEvent.touches[0] : moveE;
            const dx = mt.clientX - startX;
            const dy = mt.clientY - startY;

            if (!isDragging && Math.abs(dx) + Math.abs(dy) < 5) return;
            isDragging = true;
            $wrapper.addClass('req-display--dragging');

            const newLeft = startLeft + dx;
            const newTop = startTop + dy;

            $wrapper.css({
                left: newLeft + 'px',
                top: newTop + 'px',
                bottom: 'auto',
                transform: 'none',
            });
        };

        const onUp = () => {
            $(document).off('mousemove touchmove', onMove);
            $(document).off('mouseup touchend', onUp);
            $wrapper.removeClass('req-display--dragging');

            if (isDragging) {
                // 保存位置
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

// ===== 边界校验 =====
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

    // 检查右侧边界
    if (newX + rect.width > ww) { newX = ww - rect.width - 10; changed = true; }
    // 检查底部边界
    if (newY + rect.height > wh) { newY = wh - rect.height - 10; changed = true; }
    // 检查左侧/顶部边界
    if (newX < 10) { newX = 10; changed = true; }
    if (newY < 10) { newY = 10; changed = true; }

    if (changed) {
        settings.position.x = newX;
        settings.position.y = newY;
        $wrapper.css({
            left: newX + 'px',
            top: newY + 'px'
        });
        saveSettings();
    }
}

// ===== 事件监听 =====
function registerEventListeners() {
    // 生成开始
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    // 生成结束
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

    // 生成停止
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

    // Chat Completion prompt 就绪 → 捕获内容摘要和 token
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
}

// ===== 事件处理 =====
function onGenerationStarted(type, _params, isDryRun) {
    if (isDryRun) return;
    if (!getSettings().enabled) return;

    state.status = 'loading';
    state.startTime = Date.now();
    state.pendingPromptData = null;

    // 获取 API 和模型信息
    try {
        state.api = getGeneratingApi() || 'Unknown';
        state.model = getGeneratingModel() || '';
    } catch (e) {
        state.api = 'Unknown';
        state.model = '';
    }

    // 重置内容（等后续 prompt 事件填充）
    state.summary = '';
    state.tokens = 0;

    updateBarUI();
}

async function onChatCompletionPromptReady(eventData) {
    if (!getSettings().enabled) return;
    if (eventData.dryRun) return;

    try {
        const chat = eventData.chat;
        if (!Array.isArray(chat) || chat.length === 0) return;

        // 提取最后一条 user 消息作为摘要
        const userMsgs = chat.filter(m => m.role === 'user');
        if (userMsgs.length > 0) {
            const lastUserMsg = userMsgs[userMsgs.length - 1];
            let content = '';
            if (typeof lastUserMsg.content === 'string') {
                content = lastUserMsg.content;
            } else if (Array.isArray(lastUserMsg.content)) {
                // 多模态消息
                const textPart = lastUserMsg.content.find(p => p.type === 'text');
                content = textPart ? textPart.text : '';
            }
            state.summary = content.slice(0, 30).replace(/\n/g, ' ');
        }

        // 估算 token
        const fullText = chat.map(m => {
            if (typeof m.content === 'string') return m.content;
            if (Array.isArray(m.content)) return m.content.filter(p => p.type === 'text').map(p => p.text).join('');
            return '';
        }).join('\n');

        try {
            state.tokens = await getTokenCountAsync(fullText);
        } catch {
            // 粗略估算：中文1.5字/token，英文4字符/token
            state.tokens = Math.round(fullText.length / 2);
        }

        updateBarUI();
    } catch (e) {
        console.warn(`[${extensionName}] 捕获 prompt 数据失败:`, e);
    }
}

function onGenerationEnded(_chatLength) {
    if (!getSettings().enabled) return;
    if (state.status !== 'loading') return;

    state.status = 'done';
    state.elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);

    // 记入历史
    addHistory(false);
    updateBarUI();
}

function onGenerationStopped() {
    if (!getSettings().enabled) return;
    if (state.status !== 'loading') return;

    state.status = 'stopped';
    state.elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);

    // 记入历史
    addHistory(true);
    updateBarUI();
}

function addHistory(stopped) {
    const settings = getSettings();
    state.history.unshift({
        api: state.api,
        model: state.model,
        summary: state.summary,
        tokens: state.tokens,
        elapsed: state.elapsed,
        stopped: stopped,
        timestamp: Date.now(),
    });

    // 限制历史条数
    if (state.history.length > settings.maxHistory) {
        state.history = state.history.slice(0, settings.maxHistory);
    }

    renderHistory();
}

// ===== UI 更新 =====
function updateBarUI() {
    if (!$bar) return;

    const statusClass = {
        idle: 'req-bar--idle',
        loading: 'req-bar--loading',
        done: 'req-bar--done',
        stopped: 'req-bar--stopped',
    }[state.status] || 'req-bar--idle';

    // 更新类名
    $bar.removeClass('req-bar--idle req-bar--loading req-bar--done req-bar--stopped')
        .addClass(statusClass);

    // 更新图标
    const icons = { idle: '─', loading: '⟳', done: '✓', stopped: '⏹' };
    $icon.text(icons[state.status] || '─');

    // 更新文字
    if (state.status === 'idle') {
        $text.html('<span style="color:#6b7280">等待请求...</span>');
    } else {
        const summaryText = state.summary
            ? `<span class="req-bar__summary">${escHtml(state.summary)}${state.summary.length > 20 ? '...' : ''}</span><span class="req-bar__sep">│</span>`
            : '';

        const tokensText = state.tokens
            ? `<span class="req-bar__tokens">~${state.tokens.toLocaleString()} tk</span><span class="req-bar__sep">│</span>`
            : '';

        let timeText = '';
        if (state.status === 'loading') {
            timeText = '<span style="color:#a78bfa">...</span>';
        } else if (state.status === 'done') {
            timeText = `<span class="req-bar__time">${state.elapsed}s</span>`;
        } else if (state.status === 'stopped') {
            timeText = `<span style="color:#fb923c">${state.elapsed}s</span>`;
        }

        $text.html(`
            <span class="req-bar__api">${escHtml(state.api)}</span>
            <span class="req-bar__sep">│</span>
            <span class="req-bar__model">${escHtml(state.model)}</span>
            <span class="req-bar__sep">│</span>
            ${summaryText}
            ${tokensText}
            ${timeText}
        `);
    }
}

// ===== 工具函数 =====
function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
