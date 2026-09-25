import { api } from './ipc'

/**
 * Saves text/base64 through the main process into the export folder. `writeExportFile` takes a
 * file NAME only (the folder is chosen by `chooseExportDirectory`, default Downloads), so we ask
 * `defaultExportPath` first purely to tell the user where the file will land. Returns that path.
 */
export async function saveExport(name: string, contents: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
  const path = await api().defaultExportPath(name)
  await api().writeExportFile(name, contents, encoding)
  return path
}

/** Lets the user pick the export folder; resolves to it, or null if cancelled. */
export async function chooseExportFolder(): Promise<string | null> {
  return api().chooseExportDirectory()
}
