import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PageKey } from './nav'

export interface Prefs {
  colorPrimary: string
  defaultPage: PageKey
}

const DEFAULTS: Prefs = { colorPrimary: '#4f6ef7', defaultPage: 'dashboard' }

interface PrefsContextValue {
  prefs: Prefs
  update: (patch: Partial<Prefs>) => Promise<void>
}

const PrefsContext = createContext<PrefsContextValue>({
  prefs: DEFAULTS,
  update: async () => {}
})

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULTS)

  useEffect(() => {
    window.api.prefs
      .get()
      .then((p) => setPrefsState({ ...DEFAULTS, ...p, defaultPage: (p.defaultPage ?? 'dashboard') as PageKey }))
      .catch(() => undefined)
  }, [])

  const update = useCallback(
    async (patch: Partial<Prefs>): Promise<void> => {
      const next = { ...prefs, ...patch }
      setPrefsState(next)
      try {
        await window.api.prefs.set(next)
      } catch {
        /* ignore */
      }
    },
    [prefs]
  )

  const value = useMemo(() => ({ prefs, update }), [prefs, update])
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
}

export function usePrefs() {
  return useContext(PrefsContext)
}
