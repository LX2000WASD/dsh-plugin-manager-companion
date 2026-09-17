/**
 * PmSelect — 用官方 Menu 取代原生 `<select>` 的下拉选择器。
 *
 * 归属：C 类·需求参考（旧仓库 src/client/PmSelect.tsx 的意图：原生 select 在
 *   官方视觉体系里是异物，且无法承载图标与分组；旧实现自带样式，这里改用官方
 *   Button + Menu）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/PmSelect.tsx（未复制代码）。
 * 官方复用：@deepseek-ai/dsh-client-ui-primitives 的 Button / Menu / 图标。
 * 前提检查：旧实现的动机（官方没有可用的下拉）仍然成立——primitives 只导出
 *   Menu（锚点 + 列表），没有 Select；但它已经把键盘、外点关闭、焦点回归都做完了，
 *   所以这里只组合，不重建。
 */

import { useState } from 'react'
import { Button, IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './pmSelect.module.css'

/** 一个可选项。 */
export interface PmSelectOption {
  /** 稳定 id（提交给动作的就是它）。 */
  readonly id: string
  /** 已本地化的展示文本。 */
  readonly label: string
}

/** PmSelect 的 props。 */
export interface PmSelectProps {
  readonly value: string
  readonly options: readonly PmSelectOption[]
  readonly onChange: (id: string) => void
  /** 可访问名（已本地化）。 */
  readonly label: string
  /** 没有匹配项时显示的文本（已本地化）。 */
  readonly placeholder: string
  readonly disabled?: boolean
  readonly className?: string | undefined
}

/**
 * 渲染一个官方风格的下拉选择器。
 *
 * @param props - 当前值、选项、变更回调与文案。
 * @returns 锚点按钮与它的菜单。
 */
export function PmSelect({ value, options, onChange, label, placeholder, disabled, className }: PmSelectProps) {
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.id === value)
  const items: readonly MenuEntry[] = options.map(option => ({ id: option.id, label: option.label }))
  return (
    <Menu
      open={open}
      items={items}
      selectedId={value}
      align="start"
      onSelect={(id) => {
        setOpen(false)
        if (id !== value) onChange(id)
      }}
      onClose={() => { setOpen(false) }}
      anchor={(
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={className === undefined ? css.trigger : `${css.trigger} ${className}`}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled === true}
          onClick={() => { setOpen(previous => !previous) }}
        >
          <span className={css.value}>{current === undefined ? placeholder : current.label}</span>
          <IconChevronDownOutline14 className={css.caret} />
        </Button>
      )}
    />
  )
}
