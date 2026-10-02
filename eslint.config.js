import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  // dist/target — артефакты сборки; src-tauri — Rust. Каталоги locales
  // (корневой) и dist-web не существуют — из списка убраны
  { ignores: ['dist', 'src-tauri', 'eslint.config.js'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly', fetch: 'readonly' },
    },
    rules: {
      // Ошибки: регресс в них ломает поведение (пропущенные deps — стейл),
      // а не только стиль
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      // Compiler-era rules: architecture-level findings, tracked as warnings for now
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // non-null assertion хрупок к рефакторингу гардала: warning, чтобы
      // новые не появлялись незаметно, старые вычищены волной аудита
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },
);
