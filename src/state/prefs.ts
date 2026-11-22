/**
 * 本插件**自己的**偏好（不是柏宝绘的配置）。
 *
 * 为什么必须有自己的存储：`autoGenerate`（划线写完 tag 后是否替他点卡片）是柏宝绘
 * 根本没有的概念，它只有一个同名的 `autoTag.autoGenerate`（管的是「它自己分析完要不要
 * 自动出图」），语义完全不同，不能共用一个键。
 *
 * 边界（与 settings.ts 的只读 Proxy 分工明确）：
 * - `baibai_image` 下的东西 → **只读**，一个字节都不写（方案、画师串、副 API 全在那边改）；
 * - `extensionSettings['ST-BaiImage-CCExtra']` → 我们自己的小盒子，只放本插件独有的开关。
 *
 * 为什么不用 localStorage：这个开关是「行为偏好」，换设备应该跟着走；柏宝绘的悬浮球位置
 * 之所以放 localStorage，是因为屏幕尺寸不同、同步反而跑到屏幕外——两者动机不同。
 *
 * 容错优先：这些值可能是旧版本写的、被手改坏的、或别的东西塞进来的。任何不认识的东西
 * 一律回落到默认值，绝不让一个坏字段把面板打不开。
 */

import { getContext } from '@/st/context';

/** 存储键。与插件目录同名——ST 的 extensionSettings 惯例，也便于用户自己排查。 */
export const PREFS_KEY = 'ST-BaiImage-CCExtra';

export interface Prefs {
  /** 插件划线触发总开关。关闭后划词与点选区均不响应，无需刷新酒馆。 */
  enabled: boolean;
  /** 划线写完 tag 后是否自动点卡片的「生成图片」。关掉 = 手动模式（只写 tag）。 */
  autoGenerate: boolean;
  /** 是否先出候选、等确认再写回（= 确认式）。 */
  confirmTag: boolean;
  /** 是否让副 API 顺手交一份 Base tag 的中文对照（只给人看，绝不参与出图）。 */
  tagZhPreview: boolean;
  /** 是否显示 🍃 悬浮球。 */
  showOrb: boolean;
}

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  enabled: true,
  autoGenerate: true,
  confirmTag: false,
  tagZhPreview: true,
  showOrb: true,
});

type PrefsListener = (prefs: Prefs) => void;

const listeners = new Set<PrefsListener>();
let memory: Prefs | null = null;

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizePrefs(raw: unknown): Prefs {
  const source = isPlainObject(raw) ? raw : {};
  const enabled = asBoolean(source.enabled, DEFAULT_PREFS.enabled);
  const autoGenerate = asBoolean(source.autoGenerate, DEFAULT_PREFS.autoGenerate);
  const confirmTag = autoGenerate ? false : asBoolean(source.confirmTag, DEFAULT_PREFS.confirmTag);
  return {
    enabled,
    autoGenerate,
    confirmTag,
    tagZhPreview: asBoolean(source.tagZhPreview, DEFAULT_PREFS.tagZhPreview),
    showOrb: asBoolean(source.showOrb, DEFAULT_PREFS.showOrb),
  };
}

function readStored(): Prefs | null {
  const settings = getContext()?.extensionSettings;
  if (!settings) return null;
  return normalizePrefs(settings[PREFS_KEY]);
}

export function readPrefs(): Prefs {
  if (memory) return memory;
  return readStored() ?? { ...DEFAULT_PREFS };
}

function broadcast(next: Prefs): void {
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (error) {
      console.error('[CCX] 偏好变更回调异常', error);
    }
  }
}

export function updatePrefs(patch: Partial<Prefs>): Prefs {
  const context = getContext();
  const settings = context?.extensionSettings;
  const stored = settings?.[PREFS_KEY];
  const base = isPlainObject(stored) ? { ...stored } : {};
  const next = normalizePrefs({ ...base, ...patch });

  memory = next;

  if (settings) {
    settings[PREFS_KEY] = { ...base, ...next };
    try {
      context?.saveSettingsDebounced?.();
    } catch {
      /* ignore */
    }
  }

  broadcast(next);
  return next;
}

export function onPrefsChange(listener: PrefsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPrefs(): Prefs {
  const context = getContext();
  const settings = context?.extensionSettings;
  const next = { ...DEFAULT_PREFS };
  memory = next;

  if (settings) {
    settings[PREFS_KEY] = { ...DEFAULT_PREFS };
    try {
      context?.saveSettingsDebounced?.();
    } catch {
      /* ignore */
    }
  }

  broadcast(next);
  return next;
}

export function forgetPrefsCache(): void {
  memory = null;
}
