import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

// 官方 PLATFORM_MODULES 的逐字镜像（deepseek-harness/packages/client/web/src/platform.ts）。
// 表内必须 external：shell 共享唯一冻结实例，内联会产生第二份拷贝并分裂模块身份。
// 表外必须内联：seed table 答不出的 require 会抛 "missed the module table"，
// 导致整个客户端启动中断（不只是本插件，所有插件 UI 一起消失）。
//
// 官方表在 0.1.6-alpha.2 是 9 项，含 ui-dockkit。本表必须随 DSH 版本逐字比对；
// tests/client-boot.test.mjs 会真启动产物来验证越表 require 不会被放过。
const PLATFORM = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** 本包在模块表里的 id（与 package.json 的 name、cordis.patch.yml 的行 id 必须一致）。 */
const PACKAGE_ID = 'dsh-plugin-manager-companion'

/** 模块 CSS 的虚拟 id 前缀。
 *
 * 官方同款技巧（见 deepseek-harness/packages/client/tsdown.client.ts 的 dsh-css-modules-inline）：
 * tsdown 自带的 css 管线匹配以 .css 结尾的 id，并要求安装 @tsdown/css。把真实样式表换成
 * **不以 .css 结尾**的虚拟模块（这里用 .mjs），就能绕开那条管线，自己决定产出什么。
 */
const CSS_VIRTUAL_PREFIX = '\0companion-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** 把一个绝对或相对说明符解析成真实文件的绝对路径。 */
function assetPath(source: string, importer: string | undefined): string {
  if (isAbsolute(source)) return source
  return resolvePath(importer === undefined ? process.cwd() : dirname(importer), source)
}

/**
 * 产出一个"注入样式 + 导出类名映射"的模块。
 *
 * 为什么在 factory 执行期注入 <style> 而不是让打包器输出独立 CSS 资产：
 * 官方模块加载器的 ClientModuleSystem.claimStyles 只认领 factory 执行期注入的
 * <style data-plugin-css> 标签。独立 CSS 资产在第三方插件里**不会被自动加载**，
 * 那会让样式静默丢失。
 *
 * @param packageId - 模块表里的包 id。
 * @param fileId - 真实样式表路径（用于稳定 tagId）。
 * @param css - lightningcss 编译后的 CSS 文本。
 * @param classMap - 本地类名到哈希类名的映射；纯全局样式表省略。
 * @returns 该虚拟模块的源码。
 */
function styleInjectionModule(
  packageId: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const tagId = `${packageId}/${basename(fileId)}`
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=\\\' + JSON.stringify(tagId) + '\\]') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(packageId)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/**
 * 把 `*.module.css` 编译成官方同构的样式注入模块。
 *
 * 类名哈希用官方同款 pattern `[hash]_[local]`，使产物形态与官方插件一致，
 * 便于排查时对照。
 *
 * @returns 一个 tsdown/rolldown 插件。
 */
function cssModulesInline() {
  return {
    name: 'companion-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      return CSS_VIRTUAL_PREFIX + assetPath(source, importer) + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // 虚拟 id 让真实样式表对 Rolldown 的 watch 图不可见，必须显式登记。
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {}).sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      )) {
        classMap[local] = exp.name
      }
      return styleInjectionModule(PACKAGE_ID, fileId, code.toString(), classMap)
    },
  }
}

export default defineConfig({
  name: 'dsh-plugin-manager-companion/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  // 类型由 tsc 产出（tsconfig.client.json）；dts 会把 banner/footer 包进
  // .d.cts 破坏解析。
  dts: false,
  clean: false,
  sourcemap: false,
  external: PLATFORM,
  // 表外一律内联——它们没有共享身份可言。
  noExternal: (id: string) => (PLATFORM.includes(id) ? undefined : true),
  plugins: [cssModulesInline()],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "' + PACKAGE_ID + '", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
