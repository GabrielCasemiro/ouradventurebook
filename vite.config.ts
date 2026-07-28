import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = 4321;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api": `http://localhost:${API_PORT}`,
      "/trips": `http://localhost:${API_PORT}`,
    },
  },
});
