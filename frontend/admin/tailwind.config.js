/** @type {import('tailwindcss').Config} */
// W3 Core Admin — v0.5.1 dark command center.
// Color values stay in CSS variables (see src/styles/tokens.css); the Tailwind
// theme mirrors them so component classes can pick them up by name.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        w3navy: {
          DEFAULT: 'var(--w3-navy-900)',
          950: 'var(--w3-navy-950)',
          900: 'var(--w3-navy-900)',
          800: 'var(--w3-navy-800)',
          700: 'var(--w3-navy-700)',
          600: 'var(--w3-navy-600)'
        },
        w3gold: {
          DEFAULT: 'var(--w3-gold-500)',
          500: 'var(--w3-gold-500)',
          400: 'var(--w3-gold-400)',
          100: 'var(--w3-gold-100)'
        },
        w3card: 'var(--w3-card)',
        w3border: 'var(--w3-border)',
        'w3border-strong': 'var(--w3-border-strong)',
        w3text: 'var(--w3-text)',
        'w3text-muted': 'var(--w3-text-muted)',
        'w3text-dim': 'var(--w3-text-dim)',
        success: 'var(--status-success)',
        info: 'var(--status-info)',
        warning: 'var(--status-warning)',
        danger: 'var(--status-danger)'
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif'
        ],
        mono: [
          'ui-monospace',
          'JetBrains Mono',
          'SFMono-Regular',
          'Menlo',
          'monospace'
        ]
      }
    }
  },
  plugins: []
};
