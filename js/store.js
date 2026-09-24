// Progress persistence in localStorage (per browser/device, per JLPT level).

const key = (level) => `jlpt-prep:${level}`;

export function loadState(level) {
  try {
    const raw = localStorage.getItem(key(level));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(key(state.level), JSON.stringify(state));
    return true;
  } catch (err) {
    console.error('Could not save progress', err);
    return false;
  }
}

export function clearState(level) {
  try {
    localStorage.removeItem(key(level));
  } catch { /* ignore */ }
}

// Ask the browser not to evict our storage under pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* ignore */ }
}

export function exportState(state) {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `jlpt-prep-${state.level}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function readImport(file) {
  const data = JSON.parse(await file.text());
  if (!data || typeof data !== 'object' || !data.cards || !Array.isArray(data.queue)) {
    throw new Error('Not a JLPT Prep progress file');
  }
  return data;
}
