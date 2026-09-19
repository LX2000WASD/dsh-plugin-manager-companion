/**
 * shot-assert.mjs — 截图取证的**可见性断言**（DESIGN §12.10 的推论；CODE-POLICY §7.14）。
 *
 * 为什么需要它（同一个坑踩了三次，都是"断言过了但图上没有"）：
 *   1. trial-plan-evidence：计划区在折叠线以下，`innerText` 读得到而截图里空无一物；
 *   2. trial-cleanup-confirm-evidence：确认框没被点开（点错了同名按钮），图里框是关着的；
 *   3. about-evidence：未知态与正常态两张图 **md5 完全相同**——降级那一行在折叠线以下。
 *
 * 三次的共同点：**断言读的是 DOM 的"有没有"，而截图拍的是"看不看得见"**。
 * 这两件事在滚动容器里天然不同（`innerText` 会读滚动外的内容）。
 *
 * 所以取证脚本必须做两件事（本模块把它们变成一次调用）：
 *   · 截图前断言目标**真的在视口内**；
 *   · 两张声称不同的截图**断言 md5 不同**（"图看着对"不是判据，md5 才是）。
 *
 * 归属：A 类（新工具）。它不进 pnpm test 的 glob——真机取证需要实例与浏览器。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * 一个元素是否与视口相交（截图拍得到 ⇔ 相交）。
 *
 * 判据用 `getBoundingClientRect()` 与 `innerHeight` 求交，**不是** `offsetParent !== null`：
 * 后者只说明"没被 display:none 藏起来"，滚动到视口外时仍然为真——
 * 而那正是前两次事故的形态。
 *
 * @param selector - 目标元素的选择器（或返回元素的表达式片段）。
 * @returns 注入用的表达式（返回 true/false）。
 */
export function visibleExpr(selector) {
  return '(function(){'
    + 'var n=document.querySelector(' + JSON.stringify(selector) + ');'
    + 'if(!n) return false;'
    + 'var r=n.getBoundingClientRect();'
    + 'if(r.width===0 && r.height===0) return false;'
    + 'return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight)'
    + '  && r.right > 0 && r.left < (window.innerWidth || document.documentElement.clientWidth)})()'
}

/**
 * 把一个元素滚进视口（找它最近的可滚动祖先）。
 *
 * 为什么不用 `scrollIntoView`：它把"最近的可滚动祖先"滚到位，但**不保证**目标与视口相交
 * （居中/对齐策略由浏览器定），而且拿不到"滚了多少"这个可断言的量。
 * 这里显式算 scrollTop 并把它返回，调用方可以断言它真的变了。
 *
 * @param selector - 目标元素选择器。
 * @returns 注入用的表达式（返回 scrollTop 的字符串，或 'no-target' / 'no-scroller'）。
 */
export function scrollIntoViewExpr(selector) {
  return '(function(){'
    + 'var hit=document.querySelector(' + JSON.stringify(selector) + ');'
    + 'if(!hit) return "no-target";'
    + 'var box=null; var n=hit.parentElement;'
    + 'while(n && n!==document.body){ if(getComputedStyle(n).overflowY==="auto"){ box=n; break } n=n.parentElement }'
    + 'if(!box) return "no-scroller";'
    + 'box.scrollTop = hit.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 60;'
    + 'return String(box.scrollTop)})()'
}

/**
 * 一张截图的 md5（"两张图不一样"的唯一判据）。
 *
 * @param path - 截图文件路径。
 * @returns 十六进制 md5。
 */
export function shotMd5(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex')
}

/**
 * 断言两张截图**确实不同**。
 *
 * 用途：一个脚本声称"浅色一张、深色一张"或"正常态一张、未知态一张"时，
 * 若两张 md5 相同，那说明**第二张根本没拍到它该拍的东西**——
 * about-evidence 的第一次取证就是这么假绿的（两张图完全相同）。
 *
 * @param left - 第一张的路径。
 * @param right - 第二张的路径。
 * @param what - 描述（写进错误里）。
 * @returns 两张图的 md5。
 * @throws 两张相同时抛错。
 */
export function assertShotsDiffer(left, right, what) {
  const a = shotMd5(left)
  const b = shotMd5(right)
  if (a === b) {
    throw new Error(what + '：两张截图 md5 相同（' + a + '）——第二张没拍到它该拍的东西。'
      + '常见原因：目标元素在折叠线以下（断言读 innerText 会过，截图拍不到）。')
  }
  return { left: a, right: b }
}

/**
 * 断言一组截图**两两不同**。
 *
 * @param shots - 路径数组。
 * @param what - 描述。
 * @returns 逐张的 md5（路径 → md5）。
 * @throws 有任意两张相同时抛错。
 */
export function assertShotsDistinct(shots, what) {
  const seen = new Map()
  for (const path of shots) {
    const md5 = shotMd5(path)
    const other = seen.get(md5)
    if (other !== undefined) {
      throw new Error(what + '：' + path + ' 与 ' + other + ' 的 md5 相同（' + md5 + '）——'
        + '其中一张没拍到它该拍的东西')
    }
    seen.set(md5, path)
  }
  return Object.fromEntries([...seen].map(([md5, path]) => [path, md5]))
}
