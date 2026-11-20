const js = require('@eslint/js');
const reactPlugin = require('eslint-plugin-react');
const reactHooksPlugin = require('eslint-plugin-react-hooks');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  // Ignore patterns
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },

  // ESLint core recommended rules
  js.configs.recommended,

  // React flat config (includes plugin registration + recommended rules)
  reactPlugin.configs.flat.recommended,

  // React Hooks flat config
  reactHooksPlugin.configs.recommended,

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        alert: 'readonly',
        FormData: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
      },
    },
    plugins: {
      'prettier': require('eslint-plugin-prettier'),
    },
    rules: {
      'react/react-in-jsx-scope': 'off',  // not needed with React 17+
      'react/prop-types': 'off',          // project doesn't use PropTypes
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-duplicate-imports': 'error',    // prevent duplicate module declarations (#412)
      'prettier/prettier': 'warn',
    },
    settings: {
      react: { version: 'detect' },
    },
  },

  // Disable ESLint rules that conflict with Prettier (must be last)
  prettierConfig,
];
