import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Section 10.3: raw HTML injection is banned across the codebase; the build fails if it appears.
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML is prohibited (XSS).' },
        { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'innerHTML is prohibited (XSS).' },
      ],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
);
