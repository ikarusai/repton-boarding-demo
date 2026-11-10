# Jarvis interface fonts

These unmodified Latin WOFF2 subsets were downloaded from Google Fonts on 9 November 2026. The source URLs and SHA-256 checksums are recorded in `sources.json`.

- **Fraunces**: upright variable font, weights 400–600 and optical sizes 9–144. Copyright 2018 The Fraunces Project Authors. Use for editorial headings, with Georgia/serif fallback.
- **Inter**: upright variable font, weights 400–700. Copyright 2020 The Inter Project Authors. Use for controls and body text, with system-ui/sans-serif fallback.

Both fonts are licensed under the SIL Open Font License 1.1. The complete copyright and license notices are included in `Fraunces-OFL.txt` and `Inter-OFL.txt`. Keep those files with redistributed builds. Other Unicode scripts use system fallbacks.

The build embeds these font bytes in its stylesheet as data URLs, so using the app does not contact Google Fonts or another font host. The page policy allows `font-src data:` for these bundled fonts.

Recommended declarations:

```css
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 400 600;
  font-display: swap;
  src: url(data:font/woff2;base64,BUILD_EMBEDDED_BYTES) format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url(data:font/woff2;base64,BUILD_EMBEDDED_BYTES) format('woff2');
}
```
