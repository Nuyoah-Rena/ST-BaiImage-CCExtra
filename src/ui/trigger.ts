/**
 * 划线触发：在正文里选中一段文字后，浮出一个小工具条。
 *
 * 三个按钮（v0.2.2）：
 *   `⚡ 生成`    —— 立刻跑：分析 →（按模式）写回 / 进候选池
 *   `＋ 待生成`  —— 只记下选段，不发请求、不开面板。攒够了一键全生成
 *   `✕`         —— 丢弃本次选区（误划时的出口）
 *
 * 四条纪律（都被真实浏览器行为逼出来的）：
 *
 * 1. **捕获必须在 mouseup 当场做完**。浏览器会在下一次点击时清掉选区，
 *    等按钮的 click 回来再 `captureSelection()` 就已经没有选区了 —— 用户会看到
 *    「点了没反应」。所以 mouseup 时就地算好快照，click 只负责把快照交给执行层。
 *    三个按钮**共用同一份快照**。
 * 2. **按下按钮不许清选区**。容器级 pointerdown preventDefault（触屏）+ 每个按钮
 *    mousedown preventDefault（桌面）。漏一个，按下去的瞬间选区被清，页面还会滚一下。
 * 3. **只在 AI 剧情楼浮出**。柏宝绘的楼层按钮也不给用户楼 —— 本插件出的是 tag，
 *    用户楼没有卡片可渲染，浮出来只会点到一句「这一楼不是剧情楼层」。
 * 4. **忙态只留一个按钮**：`✕ 取消分析`。此时若还摆着「生成 / 待生成」，
 *    点它们只会得到一句"正在跑"，不如把唯一的动作做成取消。
 *
 * 定位（v0.2.5）：气泡压在**选区内部、纵向偏下**（62% 处）的位置，横向居中。
 * 为什么不再挂在选区下方：那一条是所有划线工具的**公共地盘**——系统选择菜单
 * （拷贝/翻译）、其他插件的气泡都在那儿，谁挂上去都会互相盖。
 * 仍然用 fixed 定位 + 视口钳位，不依赖任何 ST 布局容器（ST 改版不会把我们挤到页面外）。
 *
 * 可见性模型（v0.2.6 重写）：
 *
 *   **工具条的可见性是「当前选区」的纯函数**：选区非空且能捕获 → 显示；
 *   选区塌陷 → 收起；滚动 → 跟着选区重新锚定。没有任何「一次失败就永久哑火」的
 *   抑制位——v0.2.3~v0.2.5 的 `suppressed` 有一个死锁：settle 一失败就 hide，
 *   hide 发现选区还在就置抑制位，而手机上长按选区后选区长期不塌陷，
 *   于是 selectionchange 全部被拦，气泡再也不出来（真机录屏实测 32 秒不出）。
 *
 *   唯一的例外是**显式忽略**（`dismissed`）：用户点了 ✕ / Esc / 完成了一次动作，
 *   表示「这次选区我不要了」，此后滚动和 selectionchange 不再复显——
 *   直到选区塌陷，或用户做出新的手势（mouseup / touchend）。
 *
 * 触屏（v0.2.3 起，v0.2.6 重做）：手机划线靠长按 + 手柄拖动，**从头到尾没有 mouseup**。
 * 监听三路：`selectionchange`（去抖 120ms）、`touchend`（去抖 120ms，手指抬起的确定性信号）、
 * `mouseup`（桌面立即落定）。系统菜单（拷贝/翻译）依附真实选区，我们不清选区（v0.2.5 教训），
 * 气泡压在选区内部偏下避开它。
 */

/**
 * 划线触发（改版）：
 * 1. 受面板「启用划线出图」总开关控制，关闭后完全静默；
 * 2. 划词/长按选区时不主动弹出按钮，避免与其他划词插件重叠；
 * 3. 轻点一下蓝色选中区域时，在点击位置上方弹出「⚡ 生成 / ＋ 待生成 / ✕」。
 */

import { captureSelection, describeCapture, type SelectionCapture } from '@/selection/capture';
import { isAiStoryMessage, getContext } from '@/st/context';
import { cancelSelectionRun, runSelection } from '@/runner/runSelection';
import { addDraft, buildSegmentAnchor, countDrafts } from '@/state/candidates';
import { onPrefsChange, readPrefs } from '@/state/prefs';
import { diagnostic } from '@/runner/diagnostic';
import { notify } from '@/ui/notify';
import { setBusyInfo, openPanel } from '@/ui/panel';

const TOOLBAR_ID = 'ccx-select-toolbar';
const GENERATE_TEXT = '⚡ 生成';
const DRAFT_TEXT = '＋ 待生成';
const CLOSE_TEXT = '✕';
const CANCEL_TEXT = '✕ 取消分析';

const BASE_BG = 'rgba(28,36,44,.94)';
const DRAFT_BG = 'rgba(56,72,88,.94)';
const CANCEL_BG = 'rgba(180,42,46,.95)';

/** 判定为「轻点」的最大手指移动距离（px）与最长按压时间（ms）。 */
const TAP_MAX_MOVE = 14;
const TAP_MAX_DURATION = 500;
/** 蓝色选区点击命中容差（px），防止点在行间距或边缘处漏判。 */
const HIT_PADDING = 10;
/** 工具条刚弹出时的防误关保护窗口（ms），防止 touchend 后的合成 click 立刻把它关掉。 */
const OPEN_GUARD_MS = 400;
/** 触屏事件后忽略浏览器合成 mouse 事件的时间窗口（ms）。 */
const TOUCH_MOUSE_GUARD_MS = 700;

interface TapCandidate {
  capture: SelectionCapture;
  startX: number;
  startY: number;
  startTime: number;
  moved: boolean;
}

let toolbar: HTMLDivElement | null = null;
let generateButton: HTMLButtonElement | null = null;
let draftButton: HTMLButtonElement | null = null;
let closeButton: HTMLButtonElement | null = null;
let cancelButton: HTMLButtonElement | null = null;

let pending: SelectionCapture | null = null;
let tapCandidate: TapCandidate | null = null;
let openedAt = 0;
let lastTouchTime = 0;
let busy = false;
let cancelling = false;
let runningFloor: number | null = null;
let bound = false;

const COARSE_POINTER =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;

function stylePill(button: HTMLButtonElement, background: string): void {
  Object.assign(button.style, {
    padding: COARSE_POINTER ? '8px 14px' : '4px 10px',
    minHeight: COARSE_POINTER ? '36px' : '',
    border: '1px solid rgba(255,255,255,.18)',
    borderRadius: '999px',
    background,
    color: '#fff',
    font: COARSE_POINTER
      ? '500 14px/1.4 system-ui,"PingFang SC","Microsoft YaHei",sans-serif'
      : '500 12px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    touchAction: 'manipulation',
  } as Partial<CSSStyleDeclaration>);
  button.addEventListener('mousedown', event => event.preventDefault());
}

function bindButtonActivation(button: HTMLButtonElement, onClick: () => void): void {
  let lockUntil = 0;
  const fire = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now < lockUntil) return;
    lockUntil = now + 300;
    onClick();
  };
  button.addEventListener('click', fire);
  button.addEventListener('touchend', fire, { passive: false });
}

function makeButton(text: string, background: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  stylePill(button, background);
  bindButtonActivation(button, onClick);
  return button;
}

function ensureToolbar(): HTMLDivElement {
  if (toolbar && document.body.contains(toolbar)) return toolbar;

  const el = document.createElement('div');
  el.id = TOOLBAR_ID;
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '2147483000',
    display: 'none',
    alignItems: 'center',
    gap: COARSE_POINTER ? '8px' : '4px',
    background: 'transparent',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    touchAction: 'manipulation',
  } as Partial<CSSStyleDeclaration>);
  el.addEventListener('pointerdown', event => event.preventDefault());

  generateButton = makeButton(GENERATE_TEXT, BASE_BG, () => void trigger());
  draftButton = makeButton(DRAFT_TEXT, DRAFT_BG, () => parkSelection());
  closeButton = makeButton(CLOSE_TEXT, BASE_BG, () => hide());
  cancelButton = makeButton(CANCEL_TEXT, CANCEL_BG, () => cancel());
  cancelButton.style.display = 'none';

  el.append(generateButton, draftButton, closeButton, cancelButton);
  document.body.appendChild(el);
  toolbar = el;
  return el;
}

function isToolbarVisible(): boolean {
  return Boolean(toolbar && toolbar.style.display === 'flex');
}

function showAtPoint(x: number, y: number): void {
  const el = ensureToolbar();
  el.style.visibility = 'hidden';
  el.style.display = 'flex';
  const width = el.offsetWidth || 180;
  const height = el.offsetHeight || 36;
  const left = Math.min(Math.max(8, x - width / 2), Math.max(8, window.innerWidth - width - 8));
  let top = y - height - 14;
  if (top < 8) {
    top = Math.min(y + 14, Math.max(8, window.innerHeight - height - 8));
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.visibility = 'visible';
}

function hide(): void {
  pending = null;
  tapCandidate = null;
  if (toolbar) toolbar.style.display = 'none';
}

function setBusy(value: boolean, floor: number | null = null): void {
  busy = value;
  runningFloor = value ? floor : null;
  if (!toolbar || !generateButton || !draftButton || !closeButton || !cancelButton) return;
  generateButton.style.display = value ? 'none' : 'inline-block';
  draftButton.style.display = value ? 'none' : 'inline-block';
  closeButton.style.display = value ? 'none' : 'inline-block';
  cancelButton.style.display = value ? 'inline-block' : 'none';
}

function cancel(): void {
  if (!busy || cancelling || runningFloor === null) return;
  cancelling = true;
  diagnostic('trigger:cancel', { floor: runningFloor });
  cancelSelectionRun(runningFloor);
}

async function trigger(): Promise<void> {
  const capture = pending;
  if (!capture || busy) return;
  setBusy(true, capture.messageId);
  setBusyInfo({ label: `正在分析第 ${capture.messageId} 楼…`, onCancel: cancel });
  diagnostic('trigger:click', { floor: capture.messageId, chars: capture.text.length });
  try {
    const outcome = await runSelection(capture);
    if (outcome.status === 'aborted') notify('info', '已取消，正文未改动');
    if (outcome.status === 'pending') void openPanel();
  } catch (error) {
    console.error('[CCX] 划线出图异常', error);
  } finally {
    cancelling = false;
    setBusy(false);
    setBusyInfo(null);
    hide();
  }
}

function parkSelection(): void {
  const capture = pending;
  if (!capture || busy) return;
  const context = getContext();
  const message = context?.chat?.[capture.messageId];
  if (!message || typeof message.mes !== 'string') {
    notify('warning', '找不到这一楼的正文，没法加入待生成');
    return;
  }
  const chatId = context?.getCurrentChatId?.() ?? '';
  if (!chatId) {
    notify('warning', '当前没有打开的聊天，没法加入待生成');
    return;
  }
  const anchor = buildSegmentAnchor(chatId, capture, message.mes);
  const added = addDraft({ chatId, floor: capture.messageId, swipeId: capture.swipeId, segment: anchor });
  diagnostic('trigger:draft', { floor: capture.messageId, created: added.created, existing: added.existingStatus ?? null });

  if (!added.created) {
    notify(
      'info',
      added.existingStatus === 'pending' ? '这一段已经有候选了，去面板的「待确认」里看' : '这段已经在待生成里了',
    );
  } else {
    notify('info', `已加入待生成（共 ${countDrafts()} 段，尚未调用 API）`);
  }
  hide();
}

function isInsideStoryText(target: EventTarget | null): boolean {
  if (!target || typeof Node === 'undefined') return false;
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return false;
  // 避开其他插件的悬浮按钮、图标、链接和输入控件
  if (el.closest('button, a, input, textarea, select, [role="button"], svg')) return false;
  return Boolean(el.closest('.mes_text'));
}

function isPointInRange(x: number, y: number, range: Range, padding = HIT_PADDING): boolean {
  const rects = range.getClientRects();
  if (rects.length > 0) {
    for (let i = 0; i < rects.length; i += 1) {
      const r = rects[i];
      if (r.width === 0 && r.height === 0) continue;
      if (
        x >= r.left - padding &&
        x <= r.right + padding &&
        y >= r.top - padding &&
        y <= r.bottom + padding
      ) {
        return true;
      }
    }
    return false;
  }
  const box = range.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return false;
  return (
    x >= box.left - padding &&
    x <= box.right + padding &&
    y >= box.top - padding &&
    y <= box.bottom + padding
  );
}

function tryBuildTapCandidate(
  doc: Document,
  win: Window,
  x: number,
  y: number,
  target: EventTarget | null,
): TapCandidate | null {
  if (!readPrefs().enabled || busy) return null;
  if (!isInsideStoryText(target)) return null;

  const selection = doc.getSelection?.() ?? win.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!isPointInRange(x, y, range)) return null;

  const outcome = captureSelection();
  if (!outcome.ok) {
    if (outcome.reason !== 'no-selection' && outcome.reason !== 'empty-selection') {
      diagnostic('trigger:no-capture', { reason: outcome.reason, detail: outcome.detail ?? null });
    }
    return null;
  }

  const context = getContext();
  const message = context?.chat?.[outcome.capture.messageId];
  if (!isAiStoryMessage(message)) {
    diagnostic('trigger:skip', { reason: 'not-ai-story-message', floor: outcome.capture.messageId });
    return null;
  }

  return {
    capture: outcome.capture,
    startX: x,
    startY: y,
    startTime: Date.now(),
    moved: false,
  };
}

export interface TriggerOptions {
  doc?: Document;
  win?: Window;
}

export function bindSelectionTrigger(options: TriggerOptions = {}): () => void {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  if (bound) return () => {};
  bound = true;

  const unbindPrefs = onPrefsChange(prefs => {
    if (!prefs.enabled) {
      tapCandidate = null;
      if (!busy) hide();
    }
  });

  const onTouchStart = (event: TouchEvent) => {
    lastTouchTime = Date.now();
    if (event.touches.length !== 1) {
      tapCandidate = null;
      return;
    }
    if (toolbar && event.target instanceof Node && toolbar.contains(event.target)) {
      tapCandidate = null;
      return;
    }
    const touch = event.touches[0];
    const candidate = tryBuildTapCandidate(doc, win, touch.clientX, touch.clientY, event.target);
    if (candidate) {
      tapCandidate = candidate;
      return;
    }
    tapCandidate = null;
    if (isToolbarVisible() && !busy && Date.now() - openedAt > OPEN_GUARD_MS) {
      hide();
    }
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!tapCandidate || event.touches.length !== 1) {
      tapCandidate = null;
      return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - tapCandidate.startX;
    const dy = touch.clientY - tapCandidate.startY;
    if (dx * dx + dy * dy > TAP_MAX_MOVE * TAP_MAX_MOVE) {
      tapCandidate.moved = true;
      tapCandidate = null;
    }
  };

  const onTouchEnd = (event: TouchEvent) => {
    lastTouchTime = Date.now();
    const candidate = tapCandidate;
    tapCandidate = null;
    if (!candidate || candidate.moved) return;
    if (!readPrefs().enabled || busy) return;
    if (Date.now() - candidate.startTime > TAP_MAX_DURATION) return;

    const touch = event.changedTouches[0];
    const x = touch ? touch.clientX : candidate.startX;
    const y = touch ? touch.clientY : candidate.startY;
    const dx = x - candidate.startX;
    const dy = y - candidate.startY;
    if (dx * dx + dy * dy > TAP_MAX_MOVE * TAP_MAX_MOVE) return;

    pending = candidate.capture;
    openedAt = Date.now();
    console.debug(describeCapture(candidate.capture));
    showAtPoint(x, y);
  };

  const onTouchCancel = () => {
    tapCandidate = null;
  };

  const onMouseDown = (event: MouseEvent) => {
    if (Date.now() - lastTouchTime < TOUCH_MOUSE_GUARD_MS) return;
    if (event.button !== 0) return;
    if (toolbar && event.target instanceof Node && toolbar.contains(event.target)) {
      tapCandidate = null;
      return;
    }
    const candidate = tryBuildTapCandidate(doc, win, event.clientX, event.clientY, event.target);
    if (candidate) {
      tapCandidate = candidate;
      return;
    }
    tapCandidate = null;
    if (isToolbarVisible() && !busy && Date.now() - openedAt > OPEN_GUARD_MS) {
      hide();
    }
  };

  const onMouseMove = (event: MouseEvent) => {
    if (Date.now() - lastTouchTime < TOUCH_MOUSE_GUARD_MS) return;
    if (!tapCandidate) return;
    const dx = event.clientX - tapCandidate.startX;
    const dy = event.clientY - tapCandidate.startY;
    if (dx * dx + dy * dy > TAP_MAX_MOVE * TAP_MAX_MOVE) {
      tapCandidate.moved = true;
      tapCandidate = null;
    }
  };

  const onMouseUp = (event: MouseEvent) => {
    if (Date.now() - lastTouchTime < TOUCH_MOUSE_GUARD_MS) return;
    const candidate = tapCandidate;
    tapCandidate = null;
    if (!candidate || candidate.moved) return;
    if (!readPrefs().enabled || busy) return;
    if (Date.now() - candidate.startTime > TAP_MAX_DURATION) return;

    const dx = event.clientX - candidate.startX;
    const dy = event.clientY - candidate.startY;
    if (dx * dx + dy * dy > TAP_MAX_MOVE * TAP_MAX_MOVE) return;

    pending = candidate.capture;
    openedAt = Date.now();
    console.debug(describeCapture(candidate.capture));
    showAtPoint(event.clientX, event.clientY);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (busy) {
      cancel();
      return;
    }
    hide();
  };

  doc.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  doc.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  doc.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
  doc.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('mousemove', onMouseMove, true);
  doc.addEventListener('mouseup', onMouseUp, true);
  doc.addEventListener('keydown', onKeyDown, true);

  diagnostic('trigger:bound', { toolbarId: TOOLBAR_ID, coarsePointer: COARSE_POINTER, mode: 'tap-selection' });

  return () => {
    unbindPrefs();
    doc.removeEventListener('touchstart', onTouchStart, true);
    doc.removeEventListener('touchmove', onTouchMove, true);
    doc.removeEventListener('touchend', onTouchEnd, true);
    doc.removeEventListener('touchcancel', onTouchCancel, true);
    doc.removeEventListener('mousedown', onMouseDown, true);
    doc.removeEventListener('mousemove', onMouseMove, true);
    doc.removeEventListener('mouseup', onMouseUp, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    tapCandidate = null;
    toolbar?.remove();
    toolbar = null;
    generateButton = null;
    draftButton = null;
    closeButton = null;
    cancelButton = null;
    pending = null;
    busy = false;
    runningFloor = null;
    cancelling = false;
    setBusyInfo(null);
    bound = false;
  };
}
