/** Mock minimal de chrome.storage pour les tests unitaires (vitest, environnement node). */
type Area = Record<string, unknown>;

export function installChromeMock(): { local: Area; sync: Area } {
  const data = { local: {} as Area, sync: {} as Area };
  const area = (a: Area) => ({
    get: async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return structuredClone(a);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in a).map((k) => [k, structuredClone(a[k])]));
    },
    set: async (items: Area) => void Object.assign(a, structuredClone(items)),
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete a[k];
    },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(data.local), sync: area(data.sync), onChanged: { addListener() {} } },
    runtime: { getPlatformInfo: async () => ({}) },
  };
  return data;
}
