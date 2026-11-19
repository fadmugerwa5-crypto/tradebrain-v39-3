/** A tiny external store so the UI can subscribe with React's useSyncExternalStore. */
export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    return raw ? ({ ...(fallback as object), ...(JSON.parse(raw) as object) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or private mode */
  }
}
