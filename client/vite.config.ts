import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url))

export default defineConfig(({ mode }) => {
  const { PORT } = loadEnv(mode, workspaceRoot, 'PORT')
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:' + (PORT || '3000') },
    },
  }
})
