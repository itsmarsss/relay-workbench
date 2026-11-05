import assert from 'node:assert/strict';

// Check rendered text against its composed background, including nested pale cards.
// This complements visual inspection; it does not claim a full accessibility audit.
export async function assertReadableText(page) {
  const failures = await page.evaluate(() => {
    const rgb = (value) => (value.match(/[\d.]+/g) || []).map(Number);
    const blend = (front, back) =>
      front
        .slice(0, 3)
        .map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
    const luminance = (color) =>
      color
        .slice(0, 3)
        .map((value) => value / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const failures = [];
    for (const element of document.querySelectorAll('main *, .sidebar *, .topbar *')) {
      if (
        ![...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()) ||
        !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        continue;
      const style = getComputedStyle(element);
      const chain = [];
      for (let parent = element; parent; parent = parent.parentElement) chain.unshift(parent);
      let background = [255, 255, 255];
      for (const parent of chain)
        background = blend(rgb(getComputedStyle(parent).backgroundColor), background);
      const foreground = blend(rgb(style.color), background);
      const light = luminance(foreground),
        dark = luminance(background);
      const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.66 && parseInt(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5))
        failures.push({ element: element.tagName + '.' + element.className, ratio });
    }
    return failures;
  });
  assert.deepEqual(failures, [], 'Visible text must have readable contrast');
}
