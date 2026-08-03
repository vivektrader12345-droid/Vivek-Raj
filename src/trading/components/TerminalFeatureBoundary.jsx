import React, { Component } from 'react'

class TerminalFeatureBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  retry = () => {
    this.setState({ failed: false })
  }

  render() {
    const { children, feature, label = feature } = this.props

    if (this.state.failed) {
      return <div className="pro-terminal-feature-fallback" data-pro-feature-slot={feature} role="status" aria-live="polite">
        <span>{label} unavailable</span>
        <button type="button" onClick={this.retry} aria-label={`Retry ${label}`}>Retry</button>
      </div>
    }

    return <div className="pro-terminal-feature-slot" data-pro-feature-slot={feature}>{children}</div>
  }
}

export default TerminalFeatureBoundary
