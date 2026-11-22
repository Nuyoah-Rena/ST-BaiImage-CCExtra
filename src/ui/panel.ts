/**
 * 设置面板：**借用柏宝绘的界面**，不自己造一套。
 *
 * 做法与代价（写在这里，免得以后有人以为这是巧合）：
 * 柏宝绘的 UI 活在 `#bbi-app-host` 的 **open shadow root** 里，样式是它自己的 `index.css`。
 * 我们把自己的节点插进同一棵 shadow、节点自带 `class="bbi-root" data-theme=…`，
 * 于是 `.bbi-window / .bbi-body / .bbi-switch-row / .bbi-checkbox / .bbi-field-*` 直接生效——
 * 这些都在它的**全局** base.css 里，**一行 CSS 都不用复制**。
 *
 * 只有题头（`.bbi-head` / `.bbi-icon-btn`）拿不到：那几个类写在 App.vue 的 `<style scoped>` 里，
 * 编译后带 `data-v-*` 属性选择器，我们的节点没有那个属性。所以这四处用内联样式复刻同样的
 * 几何与变量（36px 圆角按钮、14px/16px 内边距），颜色仍走 `--bbi-*` → 主题照样跟随。
 *
 * 面板里分三块：
 *   ① 本插件自己的开关（自动出图 / 需确认 / 中文对照 / 显示悬浮球）；
 *   ② **待生成**：已选段、还没花额度的条目（生成 / 删除，顶部有一键全生成）；
 *   ③ **待确认**：已经有 tag 的候选（确认 / 重 Roll / 编辑 / 删除）。
 *
 * 为什么两区分开而不是混排：两种条目能做的动作不同（draft 只有生成/删除），
 * 用户的注意力也不同（待生成是「还没花额度的打算」，待确认是「已经花钱买回来的东西」）。
 * 混排时「待确认 3」会让人以为已有 3 张能确认的图，其实其中两条连 tag 都没有。
 *
 * 代价：面板依赖柏宝绘先加载。没启用时**不做备用样式**（那等于养第二份 CSS 副本，
 * 比依赖更危险），只给一句人话提示。
 */

import { diagnostic } from '@/runner/diagnostic';
import { countBatchCalls, generateDraft, generateDrafts } from '@/runner/batch';
import { commitCandidate, rerollCandidate } from '@/runner/commit';
import {
  countDrafts,
  countPending,
  editCandidateTag,
  discardCandidate,
  listCandidates,
  onCandidatesChange,
  type ImageCandidate,
} from '@/state/candidates';
import { onPrefsChange, readPrefs, updatePrefs, type Prefs } from '@/state/prefs';
import { notify } from '@/ui/notify';
import { readBaibaiTheme } from '@/ui/theme';
import { getContext } from '@/st/context';

const HOST_ID = 'bbi-app-host';
const ROOT_ID = 'ccx-panel-root';
const PANEL_TITLE = '划线出图';

const MOUNT_TIMEOUT_MS = 5000;
const MOUNT_POLL_MS = 200;

export interface BusyInfo {
  label: string;
  onCancel: () => void;
}

interface Section {
  root: HTMLElement;
  title: HTMLSpanElement;
  empty: HTMLParagraphElement;
  list: HTMLDivElement;
}

interface PanelDom {
  root: HTMLDivElement;
  overlay: HTMLDivElement;
  enabledInput: HTMLInputElement;
  autoInput: HTMLInputElement;
  confirmInput: HTMLInputElement;
  confirmRow: HTMLElement;
  zhInput: HTMLInputElement;
  orbInput: HTMLInputElement;
  busyRow: HTMLDivElement;
  busyLabel: HTMLSpanElement;
  cancelButton: HTMLButtonElement;
  drafts: Section;
  bulkButton: HTMLButtonElement;
  candidates: Section;
}

let dom: PanelDom | null = null;
let opened = false;
let busyInfo: BusyInfo | null = null;
let unbindPrefs: (() => void) | null = null;
let unbindCandidates: (() => void) | null = null;
let chatHookBound = false;
let actionBusy = false;
let editingId: string | null = null;
let editingText = '';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function baibaiShadow(): ShadowRoot | null {
  if (typeof document === 'undefined') return null;
  const host = document.getElementById(HOST_ID);
  const shadow = host?.shadowRoot ?? null;
  return shadow && shadow.childElementCount > 0 ? shadow : null;
}

function styleSmallButton(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    border: '1px solid var(--bbi-line-strong)',
    borderRadius: 'var(--bbi-radius-pill)',
    background: 'var(--bbi-surface-2)',
    color: 'var(--bbi-ink)',
    padding: '4px 14px',
    font: '600 12px/1.6 var(--bbi-font-sans)',
    cursor: 'pointer',
  } as Partial<CSSStyleDeclaration>);
}

function styleIconButton(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    width: '36px',
    height: '36px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '0',
    borderRadius: 'var(--bbi-radius-sm)',
    background: 'var(--bbi-surface-2)',
    color: 'var(--bbi-ink-soft)',
    cursor: 'pointer',
    fontSize: '15px',
  } as Partial<CSSStyleDeclaration>);
}

interface SwitchParts {
  row: HTMLLabelElement;
  input: HTMLInputElement;
  hint: HTMLParagraphElement;
}

function buildSwitch(labelText: string, hintText: string): SwitchParts {
  const row = document.createElement('label');
  row.className = 'bbi-switch-row';

  const label = document.createElement('span');
  label.className = 'bbi-field-label';
  label.textContent = labelText;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'bbi-checkbox';

  row.append(label, input);

  const hint = document.createElement('p');
  hint.className = 'bbi-field-hint';
  hint.textContent = hintText;

  return { row, input, hint };
}

function clearNode(node: HTMLElement): void {
  const candidate = node as unknown as { replaceChildren?: () => void; children?: unknown[] };
  if (typeof candidate.replaceChildren === 'function') {
    candidate.replaceChildren();
    return;
  }
  if (Array.isArray(candidate.children)) {
    candidate.children.length = 0;
    return;
  }
  node.textContent = '';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function buildSection(emptyText: string, extra?: HTMLElement): Section {
  const root = el('section');
  Object.assign(root.style, {
    marginTop: '18px',
    paddingTop: '14px',
    borderTop: '1px solid var(--bbi-line)',
  } as Partial<CSSStyleDeclaration>);

  const title = el('span', 'bbi-field-label');
  Object.assign(title.style, {
    display: 'block',
    fontWeight: '600',
    fontSize: '13px',
    color: 'var(--bbi-ink)',
    marginBottom: '8px',
  } as Partial<CSSStyleDeclaration>);

  const empty = el('p', 'bbi-field-hint');
  empty.textContent = emptyText;

  const list = el('div');
  list.style.display = 'flex';
  list.style.flexDirection = 'column';

  if (extra) root.append(extra);
  root.append(title, empty, list);
  return { root, title, empty, list };
}

function build(): PanelDom {
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'bbi-root';
  root.dataset.theme = readBaibaiTheme();
  root.style.setProperty('--bbi-win-max-w', '420px');
  root.style.setProperty('--bbi-win-max-h', 'auto');
  root.style.setProperty('--bbi-page-pad', '20px');

  const overlay = document.createElement('div');
  overlay.className = 'bbi-overlay';
  overlay.style.display = 'none';
  overlay.addEventListener('click', event => {
    if (event.target === overlay) closePanel();
  });

  const win = document.createElement('div');
  win.className = 'bbi-window';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-modal', 'true');
  win.setAttribute('aria-label', PANEL_TITLE);
  win.style.height = 'auto';
  win.style.maxHeight = '80vh';
  win.style.display = 'flex';
  win.style.flexDirection = 'column';

  const head = document.createElement('header');
  head.className = 'bbi-head';
  Object.assign(head.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    flex: '0 0 auto',
  } as Partial<CSSStyleDeclaration>);

  const brand = document.createElement('span');
  brand.className = 'bbi-brand-name';
  brand.textContent = PANEL_TITLE;
  Object.assign(brand.style, {
    fontWeight: '600',
    fontSize: '16px',
    letterSpacing: '-0.01em',
    color: 'var(--bbi-ink)',
  } as Partial<CSSStyleDeclaration>);

  const actions = document.createElement('div');
  actions.className = 'bbi-head-actions';
  actions.style.display = 'flex';
  actions.style.gap = '8px';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'bbi-icon-btn';
  closeButton.title = '关闭';
  closeButton.setAttribute('aria-label', '关闭');
  closeButton.textContent = '✕';
  styleIconButton(closeButton);
  closeButton.addEventListener('click', () => closePanel());

  actions.append(closeButton);
  head.append(brand, actions);

  const body = document.createElement('main');
  body.className = 'bbi-body';
  body.style.overflowY = 'auto';
  const page = document.createElement('div');
  page.className = 'bbi-page';

  const enabled = buildSwitch(
    '启用划线出图',
    '关闭后划词和点选区都不会弹出按钮，随时可在此重新开启，无需刷新酒馆。',
  );
  const auto = buildSwitch(
    '自动出图',
    '划完线直接开始出图。关掉则只写入 tag，由你自己点卡片上的「生成图片」。',
  );
  const confirm = buildSwitch(
    '需确认',
    '先出候选 tag，确认后才写进正文——确认即出图，不会再问一次。自动出图开着时此项不可用。',
  );
  const zh = buildSwitch(
    '中文对照',
    '让副 API 在给 tag 的同时多交一份中文直译（只用于看，不参与出图）。关掉可省一点输出长度。',
  );
  const orb = buildSwitch('显示悬浮球', '关掉后可以从魔术棒菜单（🍃 划线出图）进来这里重新打开。');

  const busyRow = document.createElement('div');
  busyRow.className = 'bbi-switch-row';
  busyRow.style.display = 'none';
  const busyLabel = document.createElement('span');
  busyLabel.className = 'bbi-field-label';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = '取消';
  styleSmallButton(cancelButton);
  busyRow.append(busyLabel, cancelButton);

  page.append(
    enabled.row,
    enabled.hint,
    auto.row,
    auto.hint,
    confirm.row,
    confirm.hint,
    zh.row,
    zh.hint,
    orb.row,
    orb.hint,
    busyRow,
  );

  const bulkButton = document.createElement('button');
  bulkButton.type = 'button';
  bulkButton.textContent = '⚡ 一键生成全部';
  styleSmallButton(bulkButton);
  bulkButton.style.marginBottom = '10px';
  bulkButton.style.display = 'none';
  bulkButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void runAction('一键生成', async () => {
      await generateDrafts();
      return { status: 'done', message: '' };
    });
  });
  const drafts = buildSection('没有待生成的选段。划选正文后轻点蓝色选区 → 点「＋ 待生成」，可以攒好几段一起生成。', bulkButton);

  const candidates = buildSection('没有待确认的画面。生成 tag 之后，候选会出现在这里等你确认。');

  page.append(drafts.root, candidates.root);
  body.append(page);
  win.append(head, body);
  overlay.append(win);
  root.append(overlay);

  return {
    root,
    overlay,
    enabledInput: enabled.input,
    autoInput: auto.input,
    confirmInput: confirm.input,
    confirmRow: confirm.row,
    zhInput: zh.input,
    orbInput: orb.input,
    busyRow,
    busyLabel,
    cancelButton,
    drafts,
    bulkButton,
    candidates,
  };
}

function syncControls(prefs: Prefs): void {
  if (!dom) return;
  if (dom.enabledInput.checked !== prefs.enabled) dom.enabledInput.checked = prefs.enabled;
  if (dom.autoInput.checked !== prefs.autoGenerate) dom.autoInput.checked = prefs.autoGenerate;
  if (dom.confirmInput.checked !== prefs.confirmTag) dom.confirmInput.checked = prefs.confirmTag;
  if (dom.zhInput.checked !== prefs.tagZhPreview) dom.zhInput.checked = prefs.tagZhPreview;
  if (dom.orbInput.checked !== prefs.showOrb) dom.orbInput.checked = prefs.showOrb;

  const locked = prefs.autoGenerate;
  dom.confirmInput.disabled = locked;
  dom.confirmRow.style.opacity = locked ? '0.45' : '1';
  dom.confirmRow.title = locked ? '自动出图开着时，划线就已经是完整闭环了，不需要再确认一次' : '';
}

function applyBusy(next: PanelDom): void {
  if (!busyInfo) {
    next.busyRow.style.display = 'none';
    next.busyLabel.textContent = '';
    return;
  }
  next.busyLabel.textContent = busyInfo.label;
  next.busyRow.style.display = 'flex';
}

function cardButton(text: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  styleSmallButton(button);
  button.style.padding = '3px 11px';
  button.style.fontSize = '12px';
  if (disabled) {
    button.disabled = true;
    button.style.opacity = '0.5';
    button.style.cursor = 'default';
  } else {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }
  return button;
}

async function runAction(label: string, fn: () => Promise<{ status: string; message: string }>): Promise<void> {
  if (actionBusy) return;
  actionBusy = true;
  renderCandidates();
  try {
    const outcome = await fn();
    if (outcome.status === 'aborted') notify('info', '已取消，正文未改动');
  } catch (error) {
    console.error(`[CCX] ${label}失败`, error);
    notify('error', `「${label}」失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    actionBusy = false;
    renderCandidates();
  }
}

function cardShell(): HTMLElement {
  const card = el('div');
  Object.assign(card.style, {
    border: '1px solid var(--bbi-line)',
    borderRadius: 'var(--bbi-radius-sm)',
    background: 'var(--bbi-surface-2)',
    padding: '10px 12px',
    marginBottom: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  } as Partial<CSSStyleDeclaration>);
  return card;
}

function cardHead(titleText: string, badgeText: string): HTMLElement {
  const head = el('div');
  Object.assign(head.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  } as Partial<CSSStyleDeclaration>);

  const title = el('span');
  title.textContent = titleText;
  Object.assign(title.style, {
    font: '600 12px/1.5 var(--bbi-font-sans)',
    color: 'var(--bbi-ink)',
  } as Partial<CSSStyleDeclaration>);

  const badge = el('span');
  badge.textContent = badgeText;
  Object.assign(badge.style, {
    font: '600 11px/1.4 var(--bbi-font-sans)',
    color: 'var(--bbi-ink-soft)',
    border: '1px solid var(--bbi-line)',
    borderRadius: 'var(--bbi-radius-pill)',
    padding: '1px 8px',
    whiteSpace: 'nowrap',
  } as Partial<CSSStyleDeclaration>);

  head.append(title, badge);
  return head;
}

function tagLine(text: string, options: { soft?: boolean; mono?: boolean } = {}): HTMLParagraphElement {
  const p = el('p');
  p.textContent = text;
  Object.assign(p.style, {
    margin: '0',
    maxHeight: options.soft ? '54px' : '72px',
    overflowY: 'auto',
    font: `${options.mono ? '11px' : '12px'}/1.55 var(--bbi-font-sans)`,
    color: options.soft ? 'var(--bbi-ink-soft)' : 'var(--bbi-ink)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } as Partial<CSSStyleDeclaration>);
  return p;
}

function buildDraftCard(item: ImageCandidate, ordinal: number): HTMLElement {
  const card = cardShell();
  const head = cardHead(`第 ${item.floor} 楼 · 选段 ${String(ordinal + 1).padStart(2, '0')}`, '待生成');

  const preview = el('p');
  preview.textContent = item.segments[0]?.text ?? '';
  Object.assign(preview.style, {
    margin: '0',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    font: '12px/1.55 var(--bbi-font-sans)',
    color: 'var(--bbi-ink)',
  } as Partial<CSSStyleDeclaration>);

  const row = el('div');
  Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' } as Partial<CSSStyleDeclaration>);
  row.append(
    cardButton('⚡ 生成 tag', () => void runAction('生成 tag', () => generateDraft(item.imageId)), actionBusy),
    cardButton(
      '✕ 删除',
      () => {
        discardCandidate(item.imageId);
        renderCandidates();
      },
      actionBusy,
    ),
  );

  card.append(head, preview, row);
  return card;
}

function buildCard(item: ImageCandidate, ordinal: number): HTMLElement {
  const card = cardShell();
  const current = item.versions[item.activeVersion];
  const head = cardHead(
    `画面 ${String(ordinal + 1).padStart(2, '0')} · 第 ${item.floor} 楼`,
    `待确认 ${item.activeVersion + 1}/${item.versions.length}`,
  );

  const editing = editingId === item.imageId;

  if (editing) {
    const area = document.createElement('textarea');
    area.value = editingText;
    Object.assign(area.style, {
      width: '100%',
      minHeight: '64px',
      boxSizing: 'border-box',
      background: 'var(--bbi-surface)',
      color: 'var(--bbi-ink)',
      border: '1px solid var(--bbi-line-strong)',
      borderRadius: 'var(--bbi-radius-sm)',
      padding: '6px 8px',
      font: '12px/1.55 var(--bbi-font-sans)',
      resize: 'vertical',
    } as Partial<CSSStyleDeclaration>);
    area.addEventListener('input', () => {
      editingText = area.value;
    });

    const hint = el('p', 'bbi-field-hint');
    hint.textContent = '只改 Base tag；角色分项只读——要改请用「重 Roll」，手改会和角色库的外貌对不上。';

    const row = el('div');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.append(
      cardButton(
        '保存',
        () => {
          if (!editCandidateTag(item.imageId, editingText)) notify('warning', '提示词不能为空');
          else {
            editingId = null;
            editingText = '';
            diagnostic('panel:candidateEdit', { imageId: item.imageId });
          }
          renderCandidates();
        },
        actionBusy,
      ),
      cardButton(
        '取消',
        () => {
          editingId = null;
          editingText = '';
          renderCandidates();
        },
        actionBusy,
      ),
    );

    card.append(head, area, hint, row);
    return card;
  }

  if (!current) {
    card.append(head, tagLine('这一条没有提示词：先点「生成 tag」。', { soft: true }));
    return card;
  }

  card.append(head, tagLine(current.image.tag));

  if (current.tagZh) {
    card.append(tagLine(current.tagZh, { soft: true }));
  } else {
    card.append(tagLine('（没有中文对照：模型没给，或你手改过英文。）', { soft: true, mono: true }));
  }

  current.image.characters.forEach((character, index) => {
    const name = el('span');
    name.textContent = `角色: ${character.name}`;
    Object.assign(name.style, {
      font: '600 11px/1.5 var(--bbi-font-sans)',
      color: 'var(--bbi-ink-soft)',
      marginTop: '2px',
    } as Partial<CSSStyleDeclaration>);
    card.append(name, tagLine(character.tag, { mono: true }));
    const zh = current.charactersZh?.[index]?.trim();
    if (zh) card.append(tagLine(zh, { soft: true }));
  });
  if (!current.image.characters.length && current.changes.some(change => change.field === 'new')) {
    card.append(tagLine('这一版没有角色分项（本次建档的角色不在画面里，重 Roll 可能更好）。', { soft: true }));
  }

  const row = el('div');
  Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' } as Partial<CSSStyleDeclaration>);
  row.append(
    cardButton('✓ 确认', () => void runAction('确认', () => commitCandidate(item.imageId)), actionBusy),
    cardButton('⟳ 重 Roll', () => void runAction('重 Roll', () => rerollCandidate(item.imageId)), actionBusy),
    cardButton(
      '✎ 编辑',
      () => {
        editingId = item.imageId;
        editingText = current.image.tag;
        renderCandidates();
      },
      actionBusy,
    ),
    cardButton(
      '✕ 删除',
      () => {
        discardCandidate(item.imageId);
        if (editingId === item.imageId) {
          editingId = null;
          editingText = '';
        }
        renderCandidates();
      },
      actionBusy,
    ),
  );

  card.append(row);
  return card;
}

export function renderCandidates(): void {
  if (!dom) return;
  paintDrafts(dom, listCandidates({ status: 'draft' }));
  paintCandidates(dom, listCandidates({ status: 'pending' }));
}

function paintSection(
  section: Section,
  emptyText: string,
  label: string,
  count: number,
  items: ImageCandidate[],
  buildItem: (item: ImageCandidate, index: number) => HTMLElement,
): void {
  section.title.textContent = count ? `${label} ${count}` : label;
  section.empty.textContent = emptyText;
  section.empty.style.display = count ? 'none' : 'block';
  clearNode(section.list);
  items.forEach((item, index) => {
    section.list.append(buildItem(item, index));
  });
}

function paintDrafts(target: PanelDom, items: ImageCandidate[]): void {
  if (items.length) {
    const calls = countBatchCalls(items.map(item => ({ imageId: item.imageId, floor: item.floor, swipeId: item.swipeId })));
    target.bulkButton.textContent = `⚡ 一键生成全部 ${items.length} 段（${calls} 次调用）`;
    target.bulkButton.style.display = 'inline-block';
    target.bulkButton.disabled = actionBusy;
    target.bulkButton.style.opacity = actionBusy ? '0.5' : '1';
  } else {
    target.bulkButton.style.display = 'none';
  }
  paintSection(
    target.drafts,
    '没有待生成的选段。划选正文后轻点蓝色选区 → 点「＋ 待生成」，可以攒好几段一起生成。',
    '待生成',
    items.length,
    items,
    buildDraftCard,
  );
}

function paintCandidates(target: PanelDom, items: ImageCandidate[]): void {
  if (editingId && !items.some(item => item.imageId === editingId)) {
    editingId = null;
    editingText = '';
  }
  paintSection(
    target.candidates,
    '没有待确认的画面。生成 tag 之后，候选会出现在这里等你确认。',
    '待确认',
    items.length,
    items,
    buildCard,
  );
}

function bindDom(next: PanelDom): void {
  next.enabledInput.addEventListener('change', () => {
    const value = next.enabledInput.checked;
    diagnostic('panel:enabled', { value });
    updatePrefs({ enabled: value });
    notify(
      'info',
      value ? '已启用划线出图：划词后轻点蓝色选区即可呼出按钮' : '已暂停划线出图（无需刷新，随时可在此重新开启）',
    );
  });

  next.autoInput.addEventListener('change', () => {
    const value = next.autoInput.checked;
    diagnostic('panel:autoGenerate', { value });
    updatePrefs({ autoGenerate: value });
    notify(
      'info',
      value ? '已开启自动出图：划线后直接出图（需确认已自动关闭）' : '已切换为手动：划完线只写 tag，出图请你点卡片',
    );
  });

  next.confirmInput.addEventListener('change', () => {
    const value = next.confirmInput.checked;
    diagnostic('panel:confirmTag', { value });
    updatePrefs({ confirmTag: value });
    if (value) notify('info', '已开启需确认：划线后先生成候选，确认才写入正文并出图');
  });

  next.zhInput.addEventListener('change', () => {
    const value = next.zhInput.checked;
    diagnostic('panel:tagZhPreview', { value });
    updatePrefs({ tagZhPreview: value });
  });

  next.orbInput.addEventListener('change', () => {
    const value = next.orbInput.checked;
    diagnostic('panel:showOrb', { value });
    updatePrefs({ showOrb: value });
  });

  next.cancelButton.addEventListener('click', () => {
    const info = busyInfo;
    diagnostic('panel:cancel', { had: Boolean(info) });
    info?.onCancel();
  });

  unbindPrefs?.();
  unbindPrefs = onPrefsChange(prefs => syncControls(prefs));

  unbindCandidates?.();
  unbindCandidates = onCandidatesChange(() => renderCandidates());

  if (!chatHookBound) {
    const context = getContext();
    const chatChanged = context?.eventTypes?.CHAT_CHANGED;
    if (chatChanged && context?.eventSource?.on) {
      context.eventSource.on(chatChanged, () => {
        editingId = null;
        editingText = '';
        renderCandidates();
      });
      chatHookBound = true;
    }
  }
}

function ensureMounted(): PanelDom | null {
  const shadow = baibaiShadow();
  if (!shadow) return null;

  const existing = shadow.getElementById(ROOT_ID) as HTMLDivElement | null;
  if (existing && dom && existing === dom.root) return dom;

  dom = build();
  shadow.appendChild(dom.root);
  bindDom(dom);
  diagnostic('panel:mounted', { theme: dom.root.dataset.theme ?? '' });
  return dom;
}

function show(next: PanelDom): void {
  next.root.dataset.theme = readBaibaiTheme();
  syncControls(readPrefs());
  applyBusy(next);
  renderCandidates();
  next.overlay.style.display = 'flex';
  opened = true;
  diagnostic('panel:open', {
    theme: next.root.dataset.theme,
    pending: countPending(),
    drafts: countDrafts(),
  });
}

export function closePanel(): void {
  if (!dom || !opened) return;
  dom.overlay.style.display = 'none';
  opened = false;
  diagnostic('panel:close', {});
}

export function isPanelOpen(): boolean {
  return opened;
}

export async function openPanel(): Promise<void> {
  const deadline = Date.now() + MOUNT_TIMEOUT_MS;
  for (;;) {
    const mounted = ensureMounted();
    if (mounted) {
      show(mounted);
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(MOUNT_POLL_MS);
  }
  diagnostic('panel:no-host', { hostId: HOST_ID, hasDocument: typeof document !== 'undefined' });
  notify('warning', '没有找到柏宝绘的界面：请先在「扩展」里启用柏宝绘，划线出图借的是它的面板样式');
}

export function togglePanel(): void {
  if (opened) closePanel();
  else void openPanel();
}

export function setBusyInfo(info: BusyInfo | null): void {
  busyInfo = info;
  if (dom) applyBusy(dom);
}

export function bindPanelHotkeys(): () => void {
  if (typeof document === 'undefined') return () => {};
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && opened) {
      event.stopPropagation();
      closePanel();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}

export function isPanelMounted(): boolean {
  return Boolean(baibaiShadow()?.getElementById(ROOT_ID));
}

export function resetPanelState(): void {
  chatHookBound = false;
  editingId = null;
  editingText = '';
  actionBusy = false;
  unbindCandidates?.();
  unbindCandidates = null;
  unbindPrefs?.();
  unbindPrefs = null;
}
