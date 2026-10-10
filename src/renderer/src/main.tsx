import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter } from 'react-router-dom'
import { App } from './app/App'
import { FeedbackProvider } from './components/Feedback'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false
    },
    mutations: { retry: false }
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <FeedbackProvider>
          <App />
        </FeedbackProvider>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>
)

