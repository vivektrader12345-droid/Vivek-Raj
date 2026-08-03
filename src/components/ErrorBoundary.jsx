import React from 'react'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('React Error Boundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#060612] flex items-center justify-center p-4">
          <div className="bg-[#1a1a2e] border border-red-500/30 rounded-2xl p-8 max-w-md w-full text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h2 className="text-white text-xl font-bold mb-2">Something went wrong</h2>
            <p className="text-gray-400 text-sm mb-4">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <div className="space-y-2">
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null })
                  window.location.reload()
                }}
                className="w-full px-4 py-2.5 bg-gradient-to-r from-[#e94560] to-[#f5a623] text-white font-medium rounded-xl hover:opacity-90 transition-opacity"
              >
                Reload App
              </button>
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null })
                }}
                className="w-full px-4 py-2.5 bg-[#0f3460]/50 text-gray-300 border border-[#0f3460] rounded-xl hover:bg-[#0f3460] transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
