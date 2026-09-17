/**
 * CSS Modules 的类型声明。
 *
 * 归属：A 类·重写（官方 ui-plugin-manager 等包各自持有一份同义声明；本仓库的
 *   tsconfig.client.json 编译面只 include src/client/index.ts，所以声明必须放在
 *   这棵被编译到的子树里）。
 * 前提检查：构建侧由 tsdown.client.config.ts 的 companion-css-modules-inline
 *   把 `*.module.css` 编译成"注入样式 + 类名映射"的虚拟模块（官方同构）。
 *   这里只补类型，不产生任何运行时代码。
 */

declare module '*.module.css' {
  /** 本地类名到哈希类名的映射（lightningcss pattern: [hash]_[local]）。 */
  const classes: Readonly<Record<string, string>>
  export default classes
}
