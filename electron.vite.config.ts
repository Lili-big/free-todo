import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-builder's Windows helper can misdecode non-ASCII project paths.
// Release scripts may expose this same directory through an ASCII drive alias.
const projectRoot = process.env.PERSONAL_TODO_PROJECT_ROOT
  ? resolve(process.env.PERSONAL_TODO_PROJECT_ROOT)
  : __dirname

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      preserveSymlinks: true,
      alias: {
        '@shared': resolve(projectRoot, 'src/shared'),
        '@main': resolve(projectRoot, 'src/main')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      preserveSymlinks: true,
      alias: {
        '@shared': resolve(projectRoot, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(projectRoot, 'src/renderer'),
    plugins: [react()],
    resolve: {
      preserveSymlinks: true,
      alias: {
        '@renderer': resolve(projectRoot, 'src/renderer'),
        '@shared': resolve(projectRoot, 'src/shared')
      }
    }
  }
})
