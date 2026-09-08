const status = document.getElementById('action-status')
const views = [...document.querySelectorAll('.evidence-view')]
const links = [...document.querySelectorAll('[data-view]')]

function selectView(id) {
  if (!views.some((view) => view.id === id)) return
  for (const view of views) view.hidden = view.id !== id
  for (const link of links) {
    link.setAttribute('aria-current', String(link.dataset.view === id))
    link.setAttribute('aria-controls', link.dataset.view)
  }
}

for (const link of document.querySelectorAll('[data-view], [data-next-view]')) {
  link.addEventListener('click', () => selectView(link.dataset.view || link.dataset.nextView))
}
function showTarget(id) {
  const target = document.getElementById(id)
  const view = target?.closest('.evidence-view')
  if (view) selectView(view.id)
  if (target?.matches('details')) target.open = true
}
for (const link of document.querySelectorAll('[data-proof]')) {
  link.addEventListener('click', () => showTarget(link.dataset.proof))
}
window.addEventListener('hashchange', () => showTarget(location.hash.slice(1)))
selectView('lookup')
showTarget(location.hash.slice(1))

for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false
  const originalLabel = button.textContent
  let resetLabel
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copy)
    clearTimeout(resetLabel)
    try {
      await navigator.clipboard.writeText(target.textContent.trim())
      button.textContent = 'Copied'
      status.textContent = 'Copied to clipboard.'
    } catch {
      const range = document.createRange()
      range.selectNodeContents(target)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      button.textContent = 'Text selected'
      status.textContent =
        'Clipboard access is unavailable. Text is selected. Use your copy shortcut.'
    }
    resetLabel = setTimeout(() => {
      button.textContent = originalLabel
    }, 2500)
  })
}

const trace = document.getElementById('evidence-trace')
const traceButton = document.querySelector('[data-trace]')
traceButton.hidden = false
traceButton.addEventListener('click', () => {
  trace.classList.remove('is-tracing')
  // Restart this short, requested diagram animation. It never executes a tool.
  void trace.offsetWidth
  trace.classList.add('is-tracing')
  status.textContent =
    'Recorded lookup path: MCP request, local SQLite index, package declaration. No new query was executed.'
})
