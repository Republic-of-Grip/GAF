# Keep GAF updated in both Helium profiles

GAF source of truth: the unpacked folder you loaded (this repo).

## Helium GAF Debug (automation / QA)

Always loads unpacked from disk via:

```powershell
powershell -ExecutionPolicy Bypass -File ./reload-gaf-debug.ps1
```

Or desktop **Helium GAF Debug** shortcut. Restart picks up every code change.

## Daily Helium (normal browsing)

1. Open `helium://extensions`
2. Enable **Developer mode**
3. Find **GAF — General Annoyance Filter**
4. Click **Reload** after every GAF change (version in the card should match `manifest.json`)

If Load unpacked is needed: select the folder that contains `manifest.json`.

## Icon state (v0.2.18+)

| Filtering | Toolbar icon |
|-----------|----------------|
| **ON** | Bright green square |
| **OFF** | Dark grey square with red slash |

Popup master switch (top right) controls this. Extensions-page toggle only loads/unloads the whole extension.
