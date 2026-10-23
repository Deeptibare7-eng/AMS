// Tailwind build config. Replaces the in-browser Play CDN (cdn.tailwindcss.com),
// which re-generated CSS on every page load and re-scanned large tables.
// Rebuild after editing views:  npm run build:css
const COLORS = ['slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green',
  'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];
const C = COLORS.join('|');

module.exports = {
  darkMode: 'class',
  content: ['./src/views/**/*.ejs', './src/**/*.js', './public/**/*.js', '!./public/vendor/**'],
  // Badge/flash classes built in templates as `bg-<%= color %>-500/10`, which the scanner can't see.
  safelist: [
    { pattern: new RegExp(`^bg-(${C})-500/(10|15)$`) },
    { pattern: new RegExp(`^border-(${C})-500/(20|30|40)$`), variants: ['hover'] },
    { pattern: new RegExp(`^bg-(${C})-400$`) },   // status dots (dashboard compliance)
    { pattern: new RegExp(`^text-(${C})-(300|400)$`) }
  ],
  theme: {
    extend: {
      colors: { hams: { bg: '#0a0a0b', card: '#141417', border: '#27272a', primary: '#3b82f6', accent: '#6366f1' } },
      fontFamily: { sans: ['Inter', 'sans-serif'], heading: ['Outfit', 'sans-serif'] }
    }
  }
};
