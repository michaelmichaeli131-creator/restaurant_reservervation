import { useEffect, useRef, useState } from 'react';

export function useFloorHistory<T extends { id: string }>(leaveMessage: string) {
  const [value, render] = useState<T | null>(null);
  const current = useRef<T | null>(null);
  const baseline = useRef('null');
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const dirty = JSON.stringify(value) !== baseline.current;
  const isDirty = () => JSON.stringify(current.current) !== baseline.current;
  function setValue(next: T | null) {
    const previous = current.current;
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    if (next?.id !== previous?.id) {
      if (isDirty() && !window.confirm(leaveMessage)) return;
      past.current = []; future.current = [];
      baseline.current = JSON.stringify(next);
    } else if (previous) {
      past.current = [...past.current.slice(-79), previous];
      future.current = [];
    }
    current.current = next; render(next);
  }
  function travel(back: boolean) {
    const from = back ? past : future;
    const to = back ? future : past;
    const next = from.current.pop();
    if (!next || !current.current) return;
    to.current.push(current.current);
    current.current = next; render(next);
  }
  function markSaved(snapshot: T) {
    if (snapshot.id !== current.current?.id) return;
    baseline.current = JSON.stringify(snapshot);
    render(current.current ? { ...current.current } : null);
  }
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
    };
    const guard = (e: Event) => { if (isDirty() && !window.confirm(leaveMessage)) e.preventDefault(); };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('floor-before-leave', guard);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('floor-before-leave', guard);
    };
  }, [leaveMessage]);
  return { value, setValue, dirty, canUndo: past.current.length > 0, canRedo: future.current.length > 0,
    undo: () => travel(true), redo: () => travel(false), markSaved };
}
