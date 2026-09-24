import { Component, type ReactNode } from 'react';

interface BoundaryProps {
  children: ReactNode;
  /** Called once when a child throws, e.g. to close the editor session it belonged to. */
  onError?: () => void;
}

/**
 * Keeps one broken region (say, the editor) from unmounting the whole in-page
 * UI. The region renders nothing until it remounts (new key).
 */
export class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('[WebMark]', error);
    this.props.onError?.();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
