/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#111827',
        muted: '#6b7280',
        accent: '#e11d2e',
        surface: '#f4f5f7',
      },
    },
  },
  plugins: [],
};