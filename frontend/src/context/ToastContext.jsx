import React, { createContext, useCallback, useContext, useState } from 'react';
import { Toast } from '../components/Toast';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const show = useCallback(
    (message, type = 'success') => setToast({ message, type, id: Date.now() + Math.random() }),
    []
  );
  const dismiss = useCallback(() => setToast(null), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <Toast key={toast.id} message={toast.message} type={toast.type} onDismiss={dismiss} />
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
