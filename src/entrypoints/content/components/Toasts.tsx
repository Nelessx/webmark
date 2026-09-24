import { useAppState, useWebmark } from './context';

export function Toasts() {
  const { actions } = useWebmark();
  const toasts = useAppState((s) => s.toasts);
  return (
    <div className="wm-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`wm-toast wm-toast--${toast.tone}`}
          data-wm-toast={toast.tone}
          onClick={() => actions.dismissToast(toast.id)}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
