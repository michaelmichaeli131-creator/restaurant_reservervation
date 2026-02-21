import { useState, useCallback, useEffect, createContext, useContext, type ReactNode } from 'react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
  /** Replacement for window.confirm() – returns a Promise<boolean> */
  confirmDialog: (message: string) => Promise<boolean>;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++nextId;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const confirmDialog = useCallback((message: string): Promise<boolean> => {
    return new Promise(resolve => {
      setDialog({ message, resolve });
    });
  }, []);

  const handleConfirm = (answer: boolean) => {
    dialog?.resolve(answer);
    setDialog(null);
  };

  // Close dialog on Escape
  useEffect(() => {
    if (!dialog) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleConfirm(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [dialog]);

  const typeColors: Record<ToastType, string> = {
    success: '#00b894',
    error: '#d63031',
    warning: '#fdcb6e',
    info: '#6c5ce7',
  };

  return (
    <ToastContext.Provider value={{ toast, confirmDialog }}>
      {children}

      {/* Toast stack */}
      <div style={{
        position: 'fixed', top: '1rem', left: '50%', transform: 'translateX(-50%)',
        zIndex: 99999, display: 'flex', flexDirection: 'column', gap: '0.5rem',
        pointerEvents: 'none',
      }}>
        {toasts.map(t => (
          <div
            key={t.id}
            role="alert"
            aria-live="assertive"
            style={{
              padding: '0.75rem 1.5rem',
              background: '#1a1d2e',
              color: '#e6e8ef',
              borderRadius: '8px',
              borderLeft: `4px solid ${typeColors[t.type]}`,
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              fontSize: '0.9rem',
              pointerEvents: 'auto',
              animation: 'toast-in 0.3s ease',
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* Confirm dialog */}
      {dialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirmation"
          style={{
            position: 'fixed', inset: 0, zIndex: 99998,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{
            background: '#1a1d2e', color: '#e6e8ef', padding: '1.5rem 2rem',
            borderRadius: '12px', maxWidth: '400px', width: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}>
            <p style={{ marginBottom: '1.5rem', lineHeight: 1.5 }}>{dialog.message}</p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => handleConfirm(false)}
                style={{
                  padding: '0.5rem 1.25rem', background: '#2d3148', color: '#e6e8ef',
                  border: 'none', borderRadius: '8px', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirm(true)}
                autoFocus
                style={{
                  padding: '0.5rem 1.25rem', background: '#d63031', color: '#fff',
                  border: 'none', borderRadius: '8px', cursor: 'pointer',
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateY(-10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </ToastContext.Provider>
  );
}
