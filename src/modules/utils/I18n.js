import ja from '../../locales/ja.js';
import zh from '../../locales/zh.js';
import ko from '../../locales/ko.js';

// Lightweight UI localisation. English is the default: dictionary keys are the
// English source strings, so an untranslated key simply renders as English and
// no key ever renders blank. Japanese, Chinese and Korean dictionaries cover
// the static chrome (title bar, explorer, settings, search, status bar, welcome
// screen); strings generated in JS keep their existing wording unless a key is
// added below.
//
// Two mechanisms:
//   * data-i18n            — replace the element's text content with t(key)
//   * data-i18n-placeholder / data-i18n-title — localise placeholder / title
// Applying is idempotent; call it again after any language change or dynamic
// DOM rebuild to pick up new nodes.

const SUPPORTED = ['en', 'ja', 'zh', 'ko'];

/**
 * Dictionaries live in src/locales/. They were inline here until the app's
 * runtime strings started going through t() as well as its static chrome,
 * at which point one file held the lookup logic and several hundred entries
 * in four languages — and every translation edit collided with every code
 * edit. English is the empty dictionary on purpose: keys ARE the English
 * text, so `en` needs no entries and a missing key anywhere falls back to
 * readable English.
 */
const DICTIONARIES = {
    en: {},
    ja,
    zh,
    ko,
};

const STORAGE_KEY = 'settings_language';

let currentLang = null;

function normalize(lang) {
    if (SUPPORTED.includes(lang)) return lang;
    const prefix = String(lang || '').split('-')[0].toLowerCase();
    return SUPPORTED.includes(prefix) ? prefix : 'en';
}

export function getLanguage() {
    if (currentLang) return currentLang;
    try {
        currentLang = normalize(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
        currentLang = 'en';
    }
    return currentLang;
}

/**
 * Tell the document what language it is in.
 *
 * Han characters are shared between Japanese, Chinese and Korean, and the
 * shapes differ. A single font stack cannot serve all three: whichever face
 * is listed first claims every Han character, so one of the languages always
 * gets the wrong forms. Splitting the stack per language is the only way, and
 * that needs `lang` on the root element — CSS has nothing else to key on.
 *
 * The attribute was missing entirely, so the browser was picking a fallback
 * face per character with no idea which language it was rendering.
 */
function applyDocumentLanguage(lang) {
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.lang = lang;
    }
}

export function setLanguage(lang) {
    currentLang = normalize(lang);
    try {
        localStorage.setItem(STORAGE_KEY, currentLang);
    } catch (_) {
        /* localStorage may be unavailable; in-memory still works */
    }
    applyDocumentLanguage(currentLang);
    applyI18n();
    return currentLang;
}

export function translate(key) {
    const dict = DICTIONARIES[getLanguage()] || DICTIONARIES.en;
    return dict[key] ?? key ?? '';
}

/**
 * Translate with optional `{placeholder}` substitution. `t('{n} files', { n: 3 })`.
 * Falls back to the key itself when no dictionary entry exists (same as `translate`).
 */
export function t(key, vars = null) {
    let s = translate(key);
    if (vars && typeof vars === 'object') {
        for (const k of Object.keys(vars)) {
            s = s.split('{' + k + '}').join(String(vars[k]));
        }
    }
    return s;
}

/**
 * Human language name for LLM system prompts, matched to the configured UI
 * language. The model is told to answer in this language.
 */
export function promptLanguageName(lang = getLanguage()) {
    switch (lang) {
        case 'ja': return 'Japanese';
        case 'zh': return 'Chinese';
        case 'ko': return 'Korean';
        default: return 'English';
    }
}

export function applyI18n(root = document) {
    applyDocumentLanguage(getLanguage());
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = translate(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.setAttribute('placeholder', translate(el.getAttribute('data-i18n-placeholder')));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.setAttribute('title', translate(el.getAttribute('data-i18n-title')));
    });
}

export { SUPPORTED };
