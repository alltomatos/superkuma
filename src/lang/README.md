# Translations

## How to translate

Edit the relevant JSON file directly in `src/lang/` and open a pull request against `develop`.

## How to add a new language in the dropdown

1. Add a new JSON file in `src/lang/` for your language code.
2. Go to `src/i18n.js` and add your language at the end of `languageList`, format: `"zh-TW": "繁體中文 (台灣)",`
3. Commit and open a pull request.

If you do not have programming skills, let us know in [the issues section](https://github.com/alltomatos/superkuma/issues).
