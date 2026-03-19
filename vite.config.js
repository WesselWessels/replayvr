import basicSsl from '@vitejs/plugin-basic-ssl'
import wasmPlugin from 'vite-plugin-wasm'

export default {
  base: process.env.NODE_ENV === 'production' ? '/replayvr/' : '/',
  plugins: [basicSsl(), wasmPlugin()],
  server: {
    https: true,
    host: true,
  },
}
