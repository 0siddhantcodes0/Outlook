import { useEffect, useId, useRef } from 'react';
import { CloseIcon } from './Icons.jsx';

// A bottom sheet built on <dialog>, which gives us focus trapping, Esc and
// inert background for free. It is open while mounted: render it
// conditionally, and each opening starts with fresh state. Mark the element
// that should get focus first with `data-autofocus` (React's autoFocus runs
// before the dialog is shown, so it has no effect here).
export default function Sheet({ title, onClose, dismissible = true, className = '', children }) {
  const ref = useRef(null);
  const opener = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
      dialog.querySelector('[data-autofocus]')?.focus();
    }
    return () => {
      // Unmounting an open dialog skips the browser's own focus restore. The
      // isConnected check skips StrictMode's simulated unmount.
      if (!dialog.isConnected && opener.current?.isConnected) opener.current.focus();
    };
  }, []);

  // React state decides when the sheet closes, so the native close is
  // always cancelled and turned into onClose.
  const handleCancel = (event) => {
    event.preventDefault();
    if (dismissible) onClose?.();
  };

  // Some browsers close anyway after repeated Esc presses; keep state in sync.
  const handleNativeClose = () => {
    if (dismissible) onClose?.();
    else ref.current?.showModal();
  };

  // A click whose target is the <dialog> itself landed on the backdrop.
  const handleClick = (event) => {
    if (dismissible && event.target === ref.current) onClose?.();
  };

  return (
    <dialog
      ref={ref}
      className={`sheet ${className}`}
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClose={handleNativeClose}
      onClick={handleClick}
    >
      <div className="sheet-header">
        <span className="sheet-grabber" aria-hidden="true" />
        <h2 id={titleId}>{title}</h2>
        {dismissible && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        )}
      </div>
      <div className="sheet-body">{children}</div>
    </dialog>
  );
}
