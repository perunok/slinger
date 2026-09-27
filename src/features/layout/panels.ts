/**
 * The right side panel's views. To add one: write a component taking `{ tab: RequestTab | null }` (the active request or
 * example tab; null when none is active, show an empty state) and register it here. Order = tab order.
 */
import type { Component } from 'svelte'
import type { RequestTab } from '../requests/tabs.svelte'
import CodeView from './panels/CodeView.svelte'
import DocsView from './panels/DocsView.svelte'
import InfoView from './panels/InfoView.svelte'
import VariablesView from './panels/VariablesView.svelte'

export interface SidePanelDef {
  id: string
  label: string
  /** Icon name (components/ui/icons.ts), for the command palette. */
  icon: string
  component: Component<{ tab: RequestTab | null }>
  /** Whether the view is offered at all (default: always). Views with nothing to show use an empty state instead. */
  available?: () => boolean
}

export const SIDE_PANELS: SidePanelDef[] = [
  { id: 'variables', label: 'Variables', icon: 'tag', component: VariablesView },
  { id: 'docs', label: 'Docs', icon: 'file', component: DocsView },
  { id: 'code', label: 'Code', icon: 'code', component: CodeView },
  { id: 'info', label: 'Info', icon: 'info', component: InfoView },
]

export function availablePanels(): SidePanelDef[] {
  return SIDE_PANELS.filter((p) => p.available?.() ?? true)
}

/** The panel to show for a stored id (falls back to the first available one). */
export function resolvePanel(id: string): SidePanelDef {
  const list = availablePanels()
  return list.find((p) => p.id === id) ?? list[0]!
}
