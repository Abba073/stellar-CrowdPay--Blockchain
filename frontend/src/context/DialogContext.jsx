import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const DialogContext = createContext(null);

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function DialogProvider({ children }) {
  const { t } = useTranslation();
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';

const DialogContext = createContext(null);

function logInteraction(message, data) {
  Sentry.addBreadcrumb({ category: 'ui.dialog', level: 'info', message, data });
}

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const [value, setValue] = useState('');
  const restoreRef = useRef(null);
  const inputRef = useRef(null);
  const confirmBtnRef = useRef(null);
  const dialogRef = useRef(null);

  const open = useCallback((kind, message, options = {}) => {
    restoreRef.current = document.activeElement;
    setValue(options.defaultValue || '');
    return new Promise((resolve) => setDialog({ kind, message, options, resolve }));
  }, []);

  const close = useCallback((result) => {
    setDialog((d) => {
      if (d) {
        logInteraction(d.options.action || d.message, {
          kind: d.kind,
          confirmed: result !== null && result !== false,
        });
        d.resolve(result);
      }
      return null;
    });
    restoreRef.current?.focus?.();
  }, []);

  useEffect(() => {
    if (!dialog) return;
    (dialog.kind === 'prompt' ? inputRef.current : confirmBtnRef.current)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') close(dialog.kind === 'prompt' ? null : false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog, close]);

  const api = {
    confirm: (message, options) => open('confirm', message, options),
    prompt: (message, options) => open('prompt', message, options),
    alert: (message, options) => open('alert', message, options),
  };

  function submit(e) {
    e.preventDefault();
    close(dialog.kind === 'prompt' ? value : true);
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 300,
          }}
        >
          <form
            role={dialog.kind === 'alert' ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-labelledby="app-dialog-message"
            onSubmit={submit}
            style={{
              background: 'var(--color-surface, #fff)',
              color: 'var(--color-text, inherit)',
              borderRadius: '10px',
              padding: '1.25rem',
              width: 'min(420px, 92vw)',
              display: 'grid',
              gap: '0.75rem',
            }}
          >
            {/* Rendered as a text node — never as HTML — so server messages are safe. */}
            <p id="app-dialog-message" style={{ margin: 0 }}>
              {dialog.message}
            </p>
            {dialog.kind === 'prompt' && (
              <input
                ref={inputRef}
                aria-labelledby="app-dialog-message"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              {dialog.kind !== 'alert' && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => close(dialog.kind === 'prompt' ? null : false)}
                >
                  Cancel
                </button>
              )}
              <button type="submit" className="btn-primary" ref={confirmBtnRef}>
                OK
              </button>
            </div>
          </form>
        </div>
      )}
    </DialogContext.Provider>
  );
}

export const useDialog = () => useContext(DialogContext);
