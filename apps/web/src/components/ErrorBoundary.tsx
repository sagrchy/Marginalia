import { Component, type ReactNode } from "react";

/** A crash in one screen should never leave a blank window: offer a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" style={{ paddingTop: "18vh" }}>
        <h2 className="h2">Something went wrong on this screen.</h2>
        <p className="muted small" style={{ margin: "8px auto 16px", maxWidth: 480 }}>
          {this.state.error.message}
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="btn" onClick={() => (window.location.hash = "#/")}>
            Library
          </button>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
