import DefaultTheme from 'vitepress/theme'
import './custom.css'

function setupMermaidZoom() {
  if ((window as any).__mermaidZoomSetup) return
  ;(window as any).__mermaidZoomSetup = true

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement

    const backdrop = target.closest('.mermaid-zoom-backdrop')
    if (backdrop) {
      backdrop.remove()
      return
    }

    const mermaidEl = target.closest('.mermaid') as HTMLElement | null
    if (!mermaidEl) return

    const svg = mermaidEl.querySelector('svg')
    if (!svg) return

    const overlay = document.createElement('div')
    overlay.className = 'mermaid-zoom-backdrop'
    overlay.appendChild(svg.cloneNode(true))
    document.body.appendChild(overlay)
  })
}

export default {
  ...DefaultTheme,
  enhanceApp() {
    if (typeof window === 'undefined') return
    setupMermaidZoom()
  },
}
