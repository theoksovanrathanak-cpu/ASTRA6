/* The DESENTO palette, in one place.

   The stylesheet carries the same values as CSS custom properties; the canvases cannot read
   those, so they import them from here. Change a colour in one file and both the DOM and
   the charts move together. */

export const T = {
  bg: '#0B0E13',
  bg2: '#10151D',
  panel: '#141B25',
  panel2: '#192230',
  chart: '#0D121A',
  toolbar: '#111824',

  line: '#273243',
  line2: '#202A38',
  line3: '#1C2531',

  ink: '#EDF2F8',
  ink2: '#A0AEC0',
  muted: '#718096',
  dim: '#526174',

  bull: '#20C997',
  bullHot: '#2CE6A5',
  bullBg: '#123B32',
  bear: '#F06470',
  bearHot: '#FF6575',
  bearBg: '#42232B',

  poc: '#F5C451',
  va: '#6598E8',
};

/* 'rgba' from a #rrggbb plus an alpha, for the heat washes on the cells */
export function wash(hex, aFactor) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.max(0, Math.min(1, aFactor)).toFixed(3) + ')';
}

export const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
