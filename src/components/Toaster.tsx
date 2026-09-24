import { useSyncExternalStore } from 'react';
import { IconAlertTriangle, IconCheck, IconX } from './icons';
import { dismissToast, getToasts, subscribeToasts } from './toast';

/** Renders toasts from showToast()/useToast(). Mount once per page, near the root. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <div className="wm-toaster" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`wm-toast wm-toast--${toast.tone}`}>
          {toast.tone === 'success' ? <IconCheck className="wm-toast__icon" /> : null}
          {toast.tone === 'danger' ? <IconAlertTriangle className="wm-toast__icon" /> : null}
          <span className="wm-toast__message">{toast.message}</span>
          <button type="button" className="wm-toast__close" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
