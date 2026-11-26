/* Chart drawings: levels and annotations the reader places themselves.

   They are anchored to market time and price, not to pixels, so they stay where they were
   put when the chart is panned, zoomed or reloaded. Kept on this device; two people looking
   at the same market keep their own marks. */

import { useCallback, useMemo, useState } from 'react';

const KEY = 'desento_drawings_v1';

export const TOOLS = [
  ['hline', 'Horizontal level', '—'],
  ['vline', 'Vertical line', '|'],
  ['trend', 'Trend line', '/'],
  ['rect', 'Rectangle', '▭'],
  ['measure', 'Measure', '↔'],
  ['erase', 'Erase', '⌫'],
];

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) { return {}; }
}

function writeAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { /* private mode */ }
}

export function useDrawings(symbol) {
  const [all, setAll] = useState(readAll);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const key = symbol || 'XAUUSD';
  const list = useMemo(() => all[key] || [], [all, key]);

  const commit = useCallback((next, remember) => {
    setAll((old) => {
      const out = { ...old, [key]: next };
      writeAll(out);
      return out;
    });
    if (remember) {
      setPast((p) => p.concat([list]).slice(-50));
      setFuture([]);
    }
  }, [key, list]);

  const add = useCallback((d) => {
    commit(list.concat([{ ...d, id: Date.now() + '-' + Math.random().toString(36).slice(2, 6) }]), true);
  }, [commit, list]);

  const remove = useCallback((id) => {
    commit(list.filter((d) => d.id !== id), true);
  }, [commit, list]);

  const clear = useCallback(() => { if (list.length) commit([], true); }, [commit, list]);

  const undo = useCallback(() => {
    if (!past.length) return;
    setFuture((f) => f.concat([list]));
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setAll((old) => { const out = { ...old, [key]: prev }; writeAll(out); return out; });
  }, [past, list, key]);

  const redo = useCallback(() => {
    if (!future.length) return;
    const next = future[future.length - 1];
    setPast((p) => p.concat([list]));
    setFuture((f) => f.slice(0, -1));
    setAll((old) => { const out = { ...old, [key]: next }; writeAll(out); return out; });
  }, [future, list, key]);

  return { list, add, remove, clear, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0 };
}
