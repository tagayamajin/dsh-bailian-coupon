/**
 * dsh-bailian-coupon — browser half smoke test.
 *
 * 目的：在没有真实浏览器/真实 React 的情况下，验证 lib/client.js 的「装配层」
 * 不会在加载或挂载阶段抛错：
 *   1. bundle 会通过 window.__ModuleLoader__.load 注册工厂（宿主就是按这个找入口）；
 *   2. factory(require) 返回 { name, inject, apply }；
 *   3. apply(ctx) 会向 sidebar.footer.action 与 settings.section 各注册一次，
 *      且 ctx.effect 的清理函数可安全执行（不抛错）；
 *   4. 两个 React 组件（徽标、设置页）能以初始状态被调用，产出元素树。
 *
 * React / react-dom/client 用最小 stub 顶替：真实宿主里它们是 baseline 模块。
 * 运行：<node> tests/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

let entry = null
const effects = []
const registrations = []

function stubReact() {
  const React = {
    createElement(type, props, ...children) {
      return { $$el: true, type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
    },
    Fragment: Symbol.for('react.fragment'),
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {
      /* 不执行副作用（不发请求、不挂监听） */
    },
    useLayoutEffect() {},
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
  }
  return React
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(registered) {
        entry = registered
      },
    },
    location: { origin: 'http://127.0.0.1:55792' },
    addEventListener() {},
    removeEventListener() {},
  },
  navigator: { language: 'zh-CN' },
  document: {
    createElement() {
      return { style: {}, appendChild() {}, remove() {}, setAttribute() {} }
    },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  },
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.reject(new Error('smoke test must not fetch')),
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: clientPath })

assert.ok(entry, 'client bundle must call window.__ModuleLoader__.load')
assert.equal(entry.id, 'dsh-bailian-coupon', 'bundle id must be the package name')

const require = (id) => {
  if (id === 'react') return stubReact()
  if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
  throw new Error('unexpected require in client bundle: ' + id)
}

const exportsObj = entry.factory(require)
assert.equal(exportsObj.name, 'bailian-coupon')
// 注意：exportsObj.inject 是在 vm 沙箱 realm 里创建的 Array，
// 与测试文件 realm 的 Array 原型不同，deepStrictEqual 会误判，故比较内容而非原型。
assert.equal([...exportsObj.inject].join(','), 'slots', 'client half only needs the slots service')
assert.equal(typeof exportsObj.apply, 'function')

const registered = []
const ctx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    if (typeof dispose === 'function') registered.push({ label, dispose })
    return () => {}
  },
  slots: {
    inject(slot, mount) {
      const dispose = mount()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

exportsObj.apply(ctx)

assert.equal(effects.length, 2, 'apply must register two effects')
assert.deepEqual(
  registrations.map((r) => [r.options.name, r.options.id, r.options.order]),
  [
    ['sidebar.footer.action', 'bailian-coupon', 40],
    ['settings.section', 'bailian-coupon', 60],
  ],
)
for (const r of registrations) {
  assert.ok(r.options.label, 'registration label is required by the slot registry')
  assert.equal(typeof r.component, 'function', 'slot component must be a React component')
}

function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.$$el) {
    const { children } = node.props
    return textOf(children)
  }
  return ''
}

for (const { options, component } of registrations) {
  const tree = component({ wide: true, close: () => {} })
  assert.ok(tree && tree.$$el, `${options.name} component must return an element`)
  const text = textOf(tree)
  assert.ok(text.length > 0, `${options.name} component should render visible text`)
}

// 清理路径不能抛错（插件被卸载/重载时宿主会调用）
for (const { label, dispose } of registered) {
  assert.doesNotThrow(() => dispose(), `dispose of ${label} must not throw`)
}

console.log('client.test.mjs OK — bundle registered, apply() wired 2 slots, components render')