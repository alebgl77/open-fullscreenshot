/**
 * FullShot — options page logic.
 *
 * One control per key in FS.Settings.DEFAULTS, wired through FS.Settings.set
 * and re-synced via FS.Settings.onChange so external changes (another
 * options tab, a future sync mechanism) are always reflected here too.
 *
 * Classic script — protocol.js, util.js and settings.js are loaded before
 * this file (see options.html).
 */
(function () {
  'use strict';

  const FS = globalThis.FS;

  /** Chrome forbids navigating an extension page to a chrome:// URL — this
   * is rendered as selectable text plus a copy button, never an <a href>. */
  const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

  const SELECT_FIELDS = [
    { id: 'opt-defaultAction', key: 'defaultAction' },
    { id: 'opt-hideFixed', key: 'hideFixed' },
    { id: 'opt-scaleMode', key: 'scaleMode' },
    { id: 'opt-afterCapture', key: 'afterCapture' },
    { id: 'opt-format', key: 'format' },
    { id: 'opt-theme', key: 'theme' },
    { id: 'opt-locale', key: 'locale' }
  ];

  const CHECKBOX_FIELDS = [
    { id: 'opt-preScrollForLazy', key: 'preScrollForLazy' },
    { id: 'opt-showHud', key: 'showHud' },
    { id: 'opt-saveAs', key: 'saveAs' }
  ];

  /**
   * "Human terms" presets for maxPixels (a raw pixel-area number is not a
   * usable control). Large/Maximum intentionally ask for more than Chrome's
   * canvas ceiling — FS.Settings.set() clamps to FS.CANVAS_LIMITS.MAX_AREA,
   * so both simply resolve to "as large as Chrome allows".
   */
  const MAXPIXELS_PRESETS = [
    { preset: 'standard', value: FS.Settings.DEFAULTS.maxPixels },
    { preset: 'large', value: 340000000 },
    { preset: 'maximum', value: 500000000 }
  ];

  const TEMPLATE_TOKENS = [
    'title',
    'host',
    'path',
    'date',
    'time',
    'datetime',
    'width',
    'height',
    'mode',
    'timestamp'
  ];

  const COMMAND_META = [
    { name: '_execute_action', labelKey: 'cmd_default' },
    { name: 'capture-fullpage', labelKey: 'cmd_fullpage' },
    { name: 'capture-visible', labelKey: 'cmd_visible' },
    { name: 'capture-region', labelKey: 'cmd_region' }
  ];

  const SAMPLE_CONTEXT = {
    title: 'Example Page Title',
    // Not a real, dereferenceable URL — just enough shape for FS.util.applyTemplate
    // to extract a sample {host}/{path}. Using a non-http(s) scheme keeps this
    // page free of any string that looks like a live network address.
    url: 'sample://example.com/path/to/page',
    width: 1920,
    height: 4032,
    mode: 'fullpage',
    date: new Date(2026, 0, 15, 9, 41, 0)
  };

  let els = {};
  let toastTimer = null;

  function setValueIfIdle(el, value) {
    if (document.activeElement !== el) el.value = value;
  }

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2500);
  }

  function pickMaxPixelsPreset(current) {
    let chosen = MAXPIXELS_PRESETS[0];
    for (const preset of MAXPIXELS_PRESETS) {
      const effective = Math.min(preset.value, FS.CANVAS_LIMITS.MAX_AREA);
      if (effective <= current) chosen = preset;
    }
    return chosen;
  }

  function setupMaxPixelsOptions() {
    const optionEls = els.maxPixels.querySelectorAll('option[data-preset]');
    optionEls.forEach((optionEl) => {
      const preset = MAXPIXELS_PRESETS.find((p) => p.preset === optionEl.getAttribute('data-preset'));
      if (preset) optionEl.value = String(preset.value);
    });
  }

  function updateQualityReadout(quality) {
    els.qualityValue.textContent = `${Math.round(Number(quality) * 100)}%`;
  }

  function updateQualityState(format) {
    const enabled = format === 'jpeg' || format === 'webp';
    els.quality.disabled = !enabled;
    els.qualityRow.classList.toggle('fs-field--disabled', !enabled);
  }

  function updateFilenamePreview() {
    const name = FS.util.applyTemplate(els.filenameTemplate.value, SAMPLE_CONTEXT);
    const ext = FS.util.extFor(els.format.value);
    els.filenamePreview.textContent = `${name}.${ext}`;
  }

  function renderTemplateLegend() {
    els.templateLegend.textContent = '';
    for (const token of TEMPLATE_TOKENS) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = `{${token}}`;
      li.appendChild(code);
      li.appendChild(document.createTextNode(' — ' + FS.util.t(`options_template_token_${token}`)));
      els.templateLegend.appendChild(li);
    }
  }

  function applyThemeAttribute(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  /** Live shortcuts, keyed by command name, falling back to the manifest's
   * suggested_key when chrome.commands.getAll() reports none. */
  async function loadShortcuts() {
    const manifest = chrome.runtime.getManifest();
    const result = {};

    for (const [name, config] of Object.entries(manifest.commands || {})) {
      const key = config.suggested_key || {};
      result[name] = key.default || key.windows || key.mac || key.linux || key.chromeos || '';
    }

    const live = await new Promise((resolve) => {
      try {
        chrome.commands.getAll((commands) => resolve(commands || []));
      } catch (_) {
        resolve([]);
      }
    });

    for (const command of live) {
      if (command.shortcut) result[command.name] = command.shortcut;
    }

    return result;
  }

  function renderShortcutList(shortcuts) {
    els.shortcutList.textContent = '';
    for (const meta of COMMAND_META) {
      const li = document.createElement('li');

      const label = document.createElement('span');
      label.textContent = FS.util.t(meta.labelKey);

      const chip = document.createElement('span');
      const shortcut = shortcuts[meta.name];
      if (shortcut) {
        chip.textContent = shortcut;
        chip.className = 'fs-shortcut-key';
      } else {
        chip.textContent = FS.util.t('popup_shortcut_not_set');
        chip.className = 'fs-shortcut-key fs-shortcut-key--unset';
      }

      li.appendChild(label);
      li.appendChild(chip);
      els.shortcutList.appendChild(li);
    }
  }

  function render(settings) {
    for (const field of SELECT_FIELDS) {
      setValueIfIdle(field.el, settings[field.key]);
    }
    for (const field of CHECKBOX_FIELDS) {
      field.el.checked = Boolean(settings[field.key]);
    }

    setValueIfIdle(els.settleMs, settings.settleMs);

    setValueIfIdle(els.quality, settings.quality);
    updateQualityReadout(settings.quality);
    updateQualityState(settings.format);

    if (document.activeElement !== els.maxPixels) {
      els.maxPixels.value = String(pickMaxPixelsPreset(settings.maxPixels).value);
    }

    setValueIfIdle(els.filenameTemplate, settings.filenameTemplate);
    updateFilenamePreview();

    applyThemeAttribute(settings.theme);
  }

  function bindSelect(field) {
    field.el.addEventListener('change', () => {
      FS.Settings.set({ [field.key]: field.el.value });
    });
  }

  function bindCheckbox(field) {
    field.el.addEventListener('change', () => {
      FS.Settings.set({ [field.key]: field.el.checked });
    });
  }

  function bindResetControls() {
    els.resetBtn.addEventListener('click', () => {
      els.resetBtn.hidden = true;
      els.resetConfirm.hidden = false;
    });
    els.resetNo.addEventListener('click', () => {
      els.resetConfirm.hidden = true;
      els.resetBtn.hidden = false;
    });
    els.resetYes.addEventListener('click', async () => {
      await FS.Settings.reset();
      els.resetConfirm.hidden = true;
      els.resetBtn.hidden = false;
      showToast(FS.util.t('options_reset_done'));
    });
  }

  function bindShortcutsCopy() {
    els.shortcutsUrl.value = SHORTCUTS_URL;
    els.shortcutsCopy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(SHORTCUTS_URL);
        showToast(FS.util.t('options_shortcuts_copied'));
      } catch (_) {
        showToast(FS.util.t('options_shortcuts_copy_failed'));
      }
    });
  }

  function cacheEls() {
    els = {
      toast: document.getElementById('fs-toast'),
      settleMs: document.getElementById('opt-settleMs'),
      quality: document.getElementById('opt-quality'),
      qualityValue: document.getElementById('opt-quality-value'),
      qualityRow: document.getElementById('opt-quality-row'),
      maxPixels: document.getElementById('opt-maxPixels'),
      filenameTemplate: document.getElementById('opt-filenameTemplate'),
      filenamePreview: document.getElementById('opt-filename-preview'),
      templateLegend: document.getElementById('opt-template-legend'),
      format: document.getElementById('opt-format'),
      theme: document.getElementById('opt-theme'),
      shortcutsUrl: document.getElementById('opt-shortcuts-url'),
      shortcutsCopy: document.getElementById('opt-shortcuts-copy'),
      shortcutList: document.getElementById('opt-shortcut-list'),
      resetBtn: document.getElementById('opt-reset-btn'),
      resetConfirm: document.getElementById('opt-reset-confirm'),
      resetYes: document.getElementById('opt-reset-yes'),
      resetNo: document.getElementById('opt-reset-no'),
      version: document.getElementById('opt-version')
    };

    for (const field of SELECT_FIELDS) field.el = document.getElementById(field.id);
    for (const field of CHECKBOX_FIELDS) field.el = document.getElementById(field.id);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    FS.util.localizeDocument();
    cacheEls();
    setupMaxPixelsOptions();
    renderTemplateLegend();
    els.version.textContent = chrome.runtime.getManifest().version;

    SELECT_FIELDS.forEach(bindSelect);
    CHECKBOX_FIELDS.forEach(bindCheckbox);

    els.settleMs.addEventListener('change', () => {
      FS.Settings.set({ settleMs: Number(els.settleMs.value) });
    });

    els.quality.addEventListener('input', () => {
      updateQualityReadout(els.quality.value);
    });
    els.quality.addEventListener('change', () => {
      FS.Settings.set({ quality: Number(els.quality.value) });
    });

    els.maxPixels.addEventListener('change', () => {
      FS.Settings.set({ maxPixels: Number(els.maxPixels.value) });
    });

    els.filenameTemplate.addEventListener('input', () => {
      updateFilenamePreview();
      FS.Settings.set({ filenameTemplate: els.filenameTemplate.value });
    });

    els.format.addEventListener('change', () => {
      updateQualityState(els.format.value);
      updateFilenamePreview();
    });

    els.theme.addEventListener('change', () => {
      applyThemeAttribute(els.theme.value);
    });

    bindResetControls();
    bindShortcutsCopy();

    const settings = await FS.Settings.get();
    render(settings);
    FS.Settings.onChange(render);

    loadShortcuts()
      .then(renderShortcutList)
      .catch(() => {
        /* No shortcut info available — the rest of the page stays usable. */
      });
  });
})();
