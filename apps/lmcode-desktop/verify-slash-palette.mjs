// End-to-end check for the Claude-style slash palette.
//
// Drives the REAL built renderer over the Chrome DevTools Protocol, so the
// assertions see the same DOM the user sees. Run:
//   pnpm run build
//   node node_modules/electron/cli.js . --remote-debugging-port=9333
//   node verify-slash-palette.mjs
//
// Exit code 0 means every contract held; 1 prints the failed assertion.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket from 'ws'

const PORT = Number(process.env.LMCDP_PORT ?? 9333)
const SHOT_DIR = resolve(import.meta.dirname, '.shots-slash')
mkdirSync(SHOT_DIR, { recursive: true })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) throw new Error(`no page target on CDP port ${PORT}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((done, fail) => {
  socket.once('open', done)
  socket.once('error', fail)
})

let nextId = 0
const pending = new Map()
socket.on('message', (raw) => {
  // `ws` hands us a Buffer here; decode explicitly so the linter can see the
  // string conversion instead of an implicit Object#toString fallback.
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw).toString('utf8')
  const message = JSON.parse(text)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
  else waiter.resolve(message.result)
})

function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolveResult, rejectResult) => {
    pending.set(id, { resolve: resolveResult, reject: rejectResult })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(detail)
  }
  return result.result.value
}

async function insertText(text) {
  await send('Input.insertText', { text })
}

async function pressKey(key, code, windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode,
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
}

/** Ctrl+A through the editing-command channel so controlled inputs see it. */
async function selectAll() {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 2,
    commands: ['selectAll'],
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  })
}

let shotIndex = 0
async function snapshot(label) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const file = resolve(SHOT_DIR, `${shotIndex++}-${label}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return file
}

const PALETTE_STATE = `(() => {
  const composer = document.querySelector('textarea[data-lm-composer="true"]')
  const palette = document.querySelector('[data-ui="slash-palette"]')
  const options = palette ? [...palette.querySelectorAll('[role="option"]')] : []
  const selected = options.find((option) => option.getAttribute('aria-selected') === 'true')
  return {
    composer: Boolean(composer),
    value: composer ? composer.value : null,
    open: Boolean(palette),
    count: options.length,
    labels: options.slice(0, 6).map((option) => option.textContent.trim()),
    selected: selected ? selected.textContent.trim() : null,
    emptyHint: palette && options.length === 0 ? palette.textContent.trim() : null,
    footer: palette ? palette.textContent.includes('Tab 补全') : false,
  }
})()`

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function clearComposer() {
  await evaluate(`(() => {
    const composer = document.querySelector('textarea[data-lm-composer="true"]')
    if (!composer) return false
    composer.value = ''
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    composer.focus()
    return true
  })()`)
  await sleep(120)
}

await send('Runtime.enable')
await send('Page.enable')

// 1. Open a session if the app is sitting on the welcome screen.
const opened = await evaluate(`(() => {
  const composer = document.querySelector('textarea[data-lm-composer="true"]')
  if (composer) return 'already'
  const button = [...document.querySelectorAll('button')]
    .find((item) => (item.textContent || '').includes('项目会话：Git 审查与工作树'))
  if (!button) return 'missing'
  button.click()
  return 'clicked'
})()`)
if (opened === 'missing') throw new Error('no slash test session found in the sidebar')
await sleep(1500)

await evaluate(`(() => {
  const composer = document.querySelector('textarea[data-lm-composer="true"]')
  if (!composer) return false
  composer.focus()
  return true
})()`)
await clearComposer()

// 2. "/" opens the palette with every command.
await insertText('/')
await sleep(300)
const initial = await evaluate(PALETTE_STATE)
assert(initial.composer, 'composer textarea is missing')
assert(initial.open, 'typing "/" did not open the slash palette')
assert(initial.count >= 8, `palette should list the built-in commands, got ${initial.count}`)
assert(initial.footer, 'palette is missing the keyboard hint footer')
const shotOpen = await snapshot('state')

// 3. Typing narrows the list.
await insertText('go')
await sleep(250)
const filtered = await evaluate(PALETTE_STATE)
assert(filtered.count >= 1, `expected /goal among the matches, got ${filtered.count}`)
assert(filtered.labels[0].includes('/goal'), `expected /goal first, got ${filtered.labels[0]}`)
assert(
  filtered.labels.every((label) => !label.includes('/goaloff')),
  'removed /goaloff is still listed',
)
const shotFiltered = await snapshot('state')

// 4. Tab completes into the composer without executing.
await pressKey('Tab', 'Tab', 9)
await sleep(250)
const completed = await evaluate(PALETTE_STATE)
assert(completed.value === '/goal ', `Tab should complete to "/goal ", got ${JSON.stringify(completed.value)}`)
assert(!completed.open, 'palette should close after completion')

// 5. Enter on a command that needs an argument inserts instead of running.
await clearComposer()
await insertText('/goal')
await sleep(250)
await pressKey('Enter', 'Enter', 13)
await sleep(250)
const entered = await evaluate(PALETTE_STATE)
assert(entered.value === '/goal ', `Enter on /goal should insert "/goal ", got ${JSON.stringify(entered.value)}`)

// 6. Enter on an argument-free command executes it (visible in the transcript).
await clearComposer()
await insertText('/help')
await sleep(250)
await pressKey('Enter', 'Enter', 13)
await sleep(600)
const ran = await evaluate(`(() => {
  const composer = document.querySelector('textarea[data-lm-composer="true"]')
  return {
    value: composer ? composer.value : null,
    helpVisible: document.body.textContent.includes('可用命令'),
    paletteOpen: Boolean(document.querySelector('[data-ui="slash-palette"]')),
  }
})()`)
assert(ran.value === '', `composer should clear after running /help, got ${JSON.stringify(ran.value)}`)
assert(ran.helpVisible, '/help did not produce the command help notice')
assert(!ran.paletteOpen, 'palette should close after running a command')
const shotRan = await snapshot('state')

// 7. Unknown query shows the empty hint without swallowing the keys.
await clearComposer()
await insertText('/zzz')
await sleep(250)
const empty = await evaluate(PALETTE_STATE)
assert(empty.open, 'palette should stay open for an unknown query')
assert(empty.count === 0, 'unknown query should match nothing')
assert(empty.emptyHint && empty.emptyHint.includes('没有匹配'), 'missing the empty-state hint')

// 8. Escape dismisses the token; editing reopens it.
await pressKey('Escape', 'Escape', 27)
await sleep(150)
assert(!(await evaluate(PALETTE_STATE)).open, 'Escape did not close the palette')
await insertText('a')
await sleep(200)
const reopened = await evaluate(PALETTE_STATE)
assert(reopened.open, 'editing the escaped token should reopen the palette')

await clearComposer()

// 9. Welcome screen: the same palette, with the command handed to the new session.
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')]
    .find((item) => (item.textContent || '').trim() === '新建对话')
  if (!button) return false
  button.click()
  return true
})()`)
await sleep(900)

const WELCOME_STATE = `(() => {
  const composer = document.querySelector('textarea[data-lm-welcome-composer="true"]')
  const palette = document.querySelector('[data-ui="slash-palette"]')
  const options = palette ? [...palette.querySelectorAll('[role="option"]')] : []
  const selected = options.find((option) => option.getAttribute('aria-selected') === 'true')
  return {
    composer: Boolean(composer),
    value: composer ? composer.value : null,
    open: Boolean(palette),
    count: options.length,
    labels: options.slice(0, 5).map((option) => option.textContent.trim()),
    selected: selected ? selected.textContent.trim() : null,
  }
})()`

assert(
  await evaluate(`Boolean(document.querySelector('textarea[data-lm-welcome-composer="true"]'))`),
  '新建对话 did not land on the welcome screen',
)
await evaluate(`document.querySelector('textarea[data-lm-welcome-composer="true"]').focus()`)
await insertText('/')
await sleep(300)
const welcomeOpen = await evaluate(WELCOME_STATE)
assert(welcomeOpen.open, 'typing "/" on the welcome screen did not open the palette')
assert(welcomeOpen.count >= 8, `welcome palette should list commands, got ${welcomeOpen.count}`)
const shotWelcome = await snapshot('welcome')

await insertText('pl')
await sleep(200)
const welcomeFiltered = await evaluate(WELCOME_STATE)
assert(welcomeFiltered.count === 1, `expected only /plan, got ${welcomeFiltered.count}`)
assert(welcomeFiltered.selected?.includes('/plan'), 'expected /plan to be highlighted')

await pressKey('Tab', 'Tab', 9)
await sleep(250)
const welcomeCompleted = await evaluate(WELCOME_STATE)
assert(
  welcomeCompleted.value === '/plan ',
  `welcome Tab should complete to "/plan ", got ${JSON.stringify(welcomeCompleted.value)}`,
)

// Enter on /help creates the session and runs the command inside it.
await selectAll()
await pressKey('Backspace', 'Backspace', 8)
await insertText('/help')
await sleep(250)
await pressKey('Enter', 'Enter', 13)
await sleep(2500)
const welcomeRan = await evaluate(`(() => {
  const composer = document.querySelector('textarea[data-lm-composer="true"]')
  return {
    sessionComposer: Boolean(composer),
    helpVisible: document.body.textContent.includes('可用命令'),
    paletteOpen: Boolean(document.querySelector('[data-ui="slash-palette"]')),
  }
})()`)
assert(welcomeRan.sessionComposer, '/help on the welcome screen did not open a session composer')
assert(welcomeRan.helpVisible, '/help did not run inside the new session')
const shotWelcomeRan = await snapshot('welcome-help')

const summary = {
  initialCount: initial.count,
  filtered: filtered.labels,
  completed: completed.value,
  entered: entered.value,
  helpVisible: ran.helpVisible,
  emptyHint: empty.emptyHint,
  reopenedOnEdit: reopened.open,
  welcomeCount: welcomeOpen.count,
  welcomeCompleted: welcomeCompleted.value,
  welcomeHelpVisible: welcomeRan.helpVisible,
  screenshots: [shotOpen, shotFiltered, shotRan, shotWelcome, shotWelcomeRan],
}
console.log(JSON.stringify(summary, null, 2))
socket.close()
