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


const demoScenes = [...document.querySelectorAll('[data-demo-scene]')]
const demoSteps = [...document.querySelectorAll('[data-demo-step]')]
const demoControls = document.querySelector('.demo-controls')
const playButton = document.querySelector('[data-demo-play]')
const restartButton = document.querySelector('[data-demo-restart]')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
let currentScene = 0
let playbackTimer
let isPlaying = false

function showScene(index, announce = false) {
  currentScene = index
  for (const scene of demoScenes) scene.hidden = Number(scene.dataset.demoScene) !== index
  for (const step of demoSteps) {
    step.setAttribute('aria-current', String(Number(step.dataset.demoStep) === index))
    step.setAttribute('aria-controls', demoScenes[Number(step.dataset.demoStep)].id)
  }
  if (announce) status.textContent = `Walkthrough step ${index + 1} of ${demoScenes.length}: ${demoScenes[index].querySelector('h3').textContent}. This is a recorded illustration; no tools are running.`
}

function stopPlayback() {
  clearTimeout(playbackTimer)
  isPlaying = false
  playButton.textContent = 'Play walkthrough'
}

function scheduleScene() {
  playbackTimer = setTimeout(() => {
    if (currentScene === demoScenes.length - 1) {
      stopPlayback()
      status.textContent = 'Walkthrough complete. Open the recorded requests and results to inspect the evidence.'
      return
    }
    showScene(currentScene + 1)
    scheduleScene()
  }, Number(demoScenes[currentScene].dataset.duration))
}

for (const step of demoSteps) {
  step.addEventListener('click', (event) => {
    event.preventDefault()
    stopPlayback()
    showScene(Number(step.dataset.demoStep), true)
  })
}
playButton.addEventListener('click', () => {
  if (isPlaying) {
    stopPlayback()
    status.textContent = 'Walkthrough paused.'
    return
  }
  if (reducedMotion.matches) return
  if (currentScene === demoScenes.length - 1) showScene(0)
  isPlaying = true
  playButton.textContent = 'Pause'
  status.textContent = 'Playing the illustrated recorded workflow. No new query is being executed.'
  scheduleScene()
})
restartButton.addEventListener('click', () => {
  stopPlayback()
  showScene(0, true)
})
reducedMotion.addEventListener('change', stopPlayback)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPlayback()
})
function showLinkedScene() {
  const index = demoScenes.findIndex((scene) => `#${scene.id}` === location.hash)
  if (index >= 0) {
    stopPlayback()
    showScene(index)
  }
}
demoControls.hidden = false
showScene(0)
showLinkedScene()
window.addEventListener('hashchange', showLinkedScene)
