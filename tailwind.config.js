/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#12122a',
        secondary: '#1a1a3e',
        accent: '#2a2a5a',
        highlight: '#e94560',
        gold: '#f5a623',
        success: '#00d68f',
        danger: '#ff3d71',
        surface: '#0a0a1f',
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'Tahoma', 'sans-serif'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'mesh-gradient': 'linear-gradient(135deg, #0a0a1f 0%, #12122a 50%, #1a1a3e 100%)',
      },
      boxShadow: {
        'glow': '0 0 15px rgba(233,69,96,0.3)',
        'glow-lg': '0 0 30px rgba(233,69,96,0.4)',
        'inner-glow': 'inset 0 0 20px rgba(233,69,96,0.1)',
      },
    },
  },
  plugins: [],
}
