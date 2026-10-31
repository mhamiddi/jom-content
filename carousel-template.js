/**
 * Middi / Jom Digital carousel template (dark + gold editorial V2).
 *
 * Port of ~/.hermes/skills/content/middi-carousel-template so the dashboard
 * renders the same 1080x1080 design that the skill defines, instead of letting
 * an image model improvise the layout. Keep tokens and structure in sync with
 * templates/carousel-template.html in that skill.
 */

const JOM_TOKENS = `
:root{
  --bg:#0E0E10; --bg-card:#16161C; --bg-card-2:#1C1C26;
  --gold:#E8B84B; --gold-light:#F5C842; --gold-border:rgba(232,184,75,0.28);
  --emerald:#34D9A5; --emerald-dim:rgba(52,217,165,0.14);
  --text-1:#F5F5F2; --text-2:#B4B4B8; --text-3:#6A6A7A;
  --border:rgba(255,255,255,0.07);
  --font-head:'Space Grotesk',sans-serif; --font-body:'Plus Jakarta Sans',sans-serif;
}
`;

const JOM_CSS = `
.md-stage{position:fixed;left:0;top:0;width:1080px;height:1080px;z-index:0;}
.md-slide{width:1080px;height:1080px;overflow:hidden;position:relative;background:var(--bg);color:var(--text-1);
  font-family:var(--font-body);box-sizing:border-box;}
.md-slide *,.md-slide *::before,.md-slide *::after{box-sizing:border-box;margin:0;padding:0;}
.md-grid{position:absolute;inset:0;pointer-events:none;
  background-image:linear-gradient(rgba(255,255,255,0.016) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.016) 1px,transparent 1px);
  background-size:90px 90px;}
.md-glow{position:absolute;border-radius:50%;pointer-events:none;}
.md-header{position:absolute;top:72px;left:72px;right:72px;display:flex;align-items:center;justify-content:space-between;z-index:20;}
.md-brand{display:flex;align-items:center;gap:13px;}
.md-avatar{width:44px;height:44px;border-radius:50%;background:linear-gradient(145deg,#E8B84B,#A07B1E);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.md-handle{font-family:var(--font-head);font-size:19px;font-weight:600;color:var(--gold);letter-spacing:.025em;}
.md-counter{font-family:var(--font-head);font-size:16px;font-weight:500;color:var(--text-3);letter-spacing:.1em;}
.md-body{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:180px 72px 132px;}
.md-eyebrow{display:flex;align-items:center;gap:12px;font-family:var(--font-head);font-size:15px;font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin-bottom:22px;}
.md-eyebrow::before{content:'';display:block;width:26px;height:2px;background:var(--gold);flex-shrink:0;}
.md-hed{font-family:var(--font-head);font-weight:700;line-height:1.08;letter-spacing:-.025em;color:var(--text-1);}
.md-hero{font-family:var(--font-head);font-weight:700;line-height:1;letter-spacing:-.03em;color:var(--gold);margin-top:22px;}
.md-hero-label{font-family:var(--font-head);font-size:22px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--text-2);margin-top:12px;}
.md-p{font-family:var(--font-body);font-size:26px;line-height:1.6;color:var(--text-2);margin-top:22px;max-width:900px;}
.md-icon{width:62px;height:62px;border-radius:14px;background:rgba(232,184,75,0.11);border:1px solid rgba(232,184,75,0.18);
  display:flex;align-items:center;justify-content:center;margin-bottom:30px;flex-shrink:0;}
.md-icon.emerald{background:var(--emerald-dim);border-color:rgba(52,217,165,0.22);}
.md-cards{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:34px;}
.md-card{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:26px 28px;}
.md-card.gold{border-color:var(--gold-border);}
.md-card-title{font-family:var(--font-head);font-size:26px;font-weight:700;color:var(--text-1);letter-spacing:-.01em;}
.md-card-body{font-family:var(--font-body);font-size:20px;line-height:1.45;color:var(--text-2);margin-top:8px;}
.md-bars{display:flex;flex-direction:column;gap:22px;margin-top:34px;}
.md-bar-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px;}
.md-bar-label{font-family:var(--font-head);font-size:22px;font-weight:600;color:var(--text-1);}
.md-bar-value{font-family:var(--font-head);font-size:22px;font-weight:700;color:var(--gold);}
.md-track{height:14px;border-radius:99px;background:rgba(255,255,255,0.07);overflow:hidden;}
.md-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#E8B84B,#F5C842);}
.md-fill.emerald{background:linear-gradient(90deg,#34D9A5,#7CF0C8);}
.md-callout{margin-top:34px;border-left:4px solid var(--gold);background:var(--bg-card);border-radius:0 16px 16px 0;
  padding:28px 32px;font-family:var(--font-head);font-size:34px;font-weight:700;line-height:1.3;color:var(--text-1);}
.md-source{position:absolute;left:72px;right:72px;bottom:142px;font-family:var(--font-body);font-size:15px;color:var(--text-3);}
.md-footer{position:absolute;bottom:72px;left:72px;right:72px;display:flex;align-items:center;gap:20px;}
.md-rule{flex:1;height:1px;background:var(--border);}
.md-footer-handle{font-family:var(--font-head);font-size:15px;font-weight:500;color:var(--text-3);letter-spacing:.06em;flex-shrink:0;}
`;

const JOM_ICONS = {
  bolt: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#E8B84B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/></svg>',
  chart: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#E8B84B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
  gear: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#E8B84B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 11a2 2 0 1 1 0 4z"/></svg>',
  bulb: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#E8B84B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V18h8v-3.3A7 7 0 0 0 12 2z"/></svg>',
  layers: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#E8B84B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>',
  users: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#E8B84B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/></svg>',
};

const JOM_ICON_BY_KIND = { hook: 'bolt', stat: 'chart', cards: 'layers', bars: 'chart', lesson: 'bulb' };

function jomEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jomHeadlineSize(text) {
  const length = [...String(text || '')].length;
  if (length > 62) return 54;
  if (length > 44) return 60;
  if (length > 28) return 66;
  return 74;
}

function jomCarouselSlide(slide, index, total) {
  const kind = JOM_ICON_BY_KIND[slide.kind] ? slide.kind : 'hook';
  const icon = JOM_ICONS[JOM_ICON_BY_KIND[kind]] || JOM_ICONS.bolt;
  const counter = String(index + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0');
  const headline = jomEsc(slide.headline || '');
  const eyebrow = jomEsc(slide.eyebrow || '');
  const body = slide.body ? `<p class="md-p">${jomEsc(slide.body)}</p>` : '';
  const hero = slide.hero ? `<div class="md-hero" style="font-size:${[...String(slide.hero)].length > 9 ? 88 : 110}px">${jomEsc(slide.hero)}</div>` : '';
  const heroLabel = slide.heroLabel ? `<div class="md-hero-label">${jomEsc(slide.heroLabel)}</div>` : '';

  let graphic = '';
  if (kind === 'cards' && Array.isArray(slide.items) && slide.items.length) {
    graphic = `<div class="md-cards">${slide.items.slice(0, 4).map((item, i) => `
      <div class="md-card${i === 0 ? ' gold' : ''}">
        <div class="md-card-title">${jomEsc(item.title || '')}</div>
        ${item.body ? `<div class="md-card-body">${jomEsc(item.body)}</div>` : ''}
      </div>`).join('')}</div>`;
  } else if (kind === 'bars' && Array.isArray(slide.items) && slide.items.length) {
    graphic = `<div class="md-bars">${slide.items.slice(0, 4).map((item) => {
      const pct = Math.max(4, Math.min(100, Math.round(Number(item.value) || 0)));
      return `<div>
        <div class="md-bar-head"><span class="md-bar-label">${jomEsc(item.title || '')}</span><span class="md-bar-value">${pct}%</span></div>
        <div class="md-track"><div class="md-fill${item.emerald ? ' emerald' : ''}" style="width:${pct}%"></div></div>
      </div>`;
    }).join('')}</div>`;
  } else if (kind === 'lesson' && slide.body) {
    graphic = `<div class="md-callout">${jomEsc(slide.body)}</div>`;
  }

  const headMarkup = kind === 'lesson'
    ? (graphic || (slide.body ? `<p class="md-p">${jomEsc(slide.body)}</p>` : ''))
    : hero + heroLabel + body + graphic;

  const source = slide.source ? `<div class="md-source">${jomEsc(slide.source)}</div>` : '';

  return `<div class="md-slide" data-slide="${index + 1}">
  <div class="md-grid"></div>
  <div class="md-glow" style="width:640px;height:640px;background:radial-gradient(circle,rgba(232,184,75,0.09) 0%,transparent 65%);top:-180px;right:-160px;"></div>
  <div class="md-glow" style="width:300px;height:300px;background:radial-gradient(circle,rgba(232,184,75,0.05) 0%,transparent 70%);bottom:60px;left:-60px;"></div>
  <div class="md-header">
    <div class="md-brand">
      <div class="md-avatar"><svg width="23" height="18" viewBox="0 0 20 16" fill="none"><polyline points="1,15 1,1 10,11 19,1 19,15" stroke="#0E0E10" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <span class="md-handle">@hamiddi_</span>
    </div>
    <span class="md-counter">${counter}</span>
  </div>
  <div class="md-body">
    <div class="md-icon">${icon}</div>
    <div class="md-eyebrow">${eyebrow}</div>
    <h1 class="md-hed" style="font-size:${jomHeadlineSize(slide.headline)}px">${headline}</h1>
    ${headMarkup}
  </div>
  ${source}
  <div class="md-footer"><div class="md-rule"></div><span class="md-footer-handle">@hamiddi_</span></div>
</div>`;
}

function jomCarouselStyles() {
  return JOM_TOKENS + JOM_CSS;
}

window.JomCarousel = { slide: jomCarouselSlide, styles: jomCarouselStyles };
