// Static decoration with no remote assets, timers or changes to the host theme.
const abyssalStars = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220">
  <g fill="none" stroke="#86abd5" stroke-opacity=".16" stroke-width=".6"><path d="m26 44 53 21 43-38 52 50M212 153l40-31 49 22 33-45"/></g>
  <g fill="#b9d0eb" fill-opacity=".55"><circle cx="26" cy="44" r="1.1"/><circle cx="79" cy="65" r="1.4"/><circle cx="122" cy="27" r="1"/><circle cx="174" cy="77" r="1.2"/><circle cx="212" cy="153" r="1"/><circle cx="252" cy="122" r="1.3"/><circle cx="301" cy="144" r="1"/><circle cx="334" cy="99" r="1.4"/><circle cx="41" cy="166" r=".7"/><circle cx="139" cy="132" r=".6"/><circle cx="284" cy="42" r=".8"/><circle cx="184" cy="199" r=".7"/></g>
  <g fill="#e0cfaa" fill-opacity=".65"><path d="m226 27 1.5 4.5L232 33l-4.5 1.5L226 39l-1.5-4.5L220 33l4.5-1.5z"/><path d="m93 182 1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/></g>
</svg>`)}")`;

export const ABYSSAL_THEME_CSS = `
  :where(.ensemble-tts,.choir-mixer,.choir-auto-plan-action,.choir-follow-resume){
    --abyss-bg:#061323;--abyss-surface:#0d2138;--abyss-hover:#15304d;
    --abyss-accent:#86abd5;--abyss-accent-hover:#a3c3e8;
    --abyss-text:#eaf1fb;--abyss-muted:#b8c9dd;--abyss-dim:#91a8c1;
    --abyss-gold:var(--ac-starlight,#e0cfaa);
    --abyss-line:rgb(151 187 224 / 27%);--abyss-line-hover:rgb(177 211 245 / 48%);
    --abyss-stars:${abyssalStars};color-scheme:dark;
  }
  .ensemble-tts{
    color:var(--abyss-text);
    background:radial-gradient(ellipse at 100% 0%,rgb(35 83 134 / 25%),transparent 48%),linear-gradient(160deg,#0b1c32,var(--abyss-bg) 70%);
    border:1px solid var(--abyss-line);border-radius:16px;
    box-shadow:inset 0 1px 0 rgb(185 208 235 / 7%),0 12px 32px rgb(1 7 16 / 20%);
    font-family:var(--ac-ui-font,"Segoe UI",system-ui,sans-serif);
  }
  .ensemble-tts .et-header{background-image:var(--abyss-stars);background-position:right top;border-bottom-color:var(--abyss-line);padding-top:6px}
  .ensemble-tts .et-title-group{flex-wrap:wrap;gap:8px}
  .ensemble-tts h2{font-family:var(--ac-display-font,Georgia,serif);font-size:1.65em;font-weight:600;letter-spacing:.035em;color:var(--abyss-gold);text-shadow:0 0 18px rgb(134 171 213 / 18%)}
  .ensemble-tts h2::before{content:"✦";font-size:.65em;margin-right:8px;color:var(--abyss-accent-hover)}
  .ensemble-tts .et-constellation-name{display:block;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--abyss-muted);margin-top:1px}
  .ensemble-tts .et-badge{color:var(--abyss-accent-hover);border-color:var(--abyss-line);background:rgb(134 171 213 / 8%);opacity:1;border-radius:999px}
  .ensemble-tts .et-save-state{color:var(--abyss-muted);opacity:1}
  .ensemble-tts h3{color:var(--abyss-gold);opacity:1;letter-spacing:.09em;font-size:.86em}
  .ensemble-tts h3::before{content:"✧";margin-right:7px;color:var(--abyss-accent)}
  .ensemble-tts .et-subhead{color:var(--abyss-dim);opacity:1;letter-spacing:.08em;text-transform:uppercase;font-size:.72em}
  .ensemble-tts label{color:var(--abyss-muted)}
  .ensemble-tts input,.ensemble-tts select,.ensemble-tts textarea{color:var(--abyss-text);background:rgb(4 13 27 / 76%);border-color:var(--abyss-line);border-radius:9px}
  .ensemble-tts input::placeholder,.ensemble-tts textarea::placeholder{color:var(--abyss-dim);opacity:1}
  .ensemble-tts select option{background:#081b30;color:var(--abyss-text)}
  .ensemble-tts input:focus,.ensemble-tts select:focus,.ensemble-tts textarea:focus{border-color:var(--abyss-accent);box-shadow:0 0 0 3px rgb(134 171 213 / 12%)}
  .ensemble-tts :is(input,select,textarea,button,summary):focus-visible{outline:2px solid var(--abyss-accent-hover);outline-offset:3px}
  .ensemble-tts input[type="checkbox"],.ensemble-tts input[type="radio"]{accent-color:var(--abyss-accent)}
  .ensemble-tts button{color:var(--abyss-text);border-color:var(--abyss-line);background:linear-gradient(180deg,rgb(28 56 88 / 80%),rgb(11 30 54 / 85%));border-radius:9px}
  .ensemble-tts button:hover:not(:disabled){background:var(--abyss-hover);border-color:var(--abyss-line-hover)}
  .ensemble-tts .et-btn-primary,.ensemble-tts [data-et="latest"]{background:linear-gradient(145deg,#a3c3e8,#86abd5);color:#061323;border-color:#b9d0eb;box-shadow:0 3px 12px rgb(134 171 213 / 15%)}
  .ensemble-tts .et-btn-primary:hover:not(:disabled),.ensemble-tts [data-et="latest"]:hover:not(:disabled){background:#b9d0eb}
  .ensemble-tts .et-btn-danger{color:#ffb4b9}
  .ensemble-tts .et-card{border-color:var(--abyss-line);border-radius:12px;background:linear-gradient(140deg,rgb(21 48 77 / 58%),rgb(8 23 42 / 86%));box-shadow:inset 0 1px 0 rgb(185 208 235 / 5%)}
  .ensemble-tts .et-cast-header strong{color:var(--abyss-gold);font-family:var(--ac-display-font,Georgia,serif);font-size:1.05em;letter-spacing:.02em}
  .ensemble-tts .et-cast-editor{border-top-color:var(--abyss-line)}
  .ensemble-tts .et-status{color:var(--abyss-muted);border:1px solid rgb(134 171 213 / 16%);border-radius:10px;background:rgb(13 33 56 / 70%)}
  .ensemble-tts .et-error{color:#ffb4b9;border-color:rgb(255 180 185 / 32%)}
  .ensemble-tts .et-plan-block{border-bottom-color:var(--abyss-line)}
  .ensemble-tts details{border-color:var(--abyss-line);border-radius:10px;background:rgb(8 23 42 / 48%)}
  .ensemble-tts details summary{color:var(--abyss-accent-hover);opacity:1}
  .ensemble-tts a{color:#a9d1fa}
  .ensemble-tts.et-default-dialog{background:radial-gradient(ellipse at 100% 0%,rgb(35 83 134 / 25%),transparent 50%),linear-gradient(155deg,#0d2138,#061323 75%);color:var(--abyss-text);border-color:var(--abyss-line-hover);box-shadow:0 24px 80px rgb(1 7 16 / 65%),0 0 28px rgb(134 171 213 / 8%)}
  .et-default-overlay{background:rgb(1 7 16 / 74%);backdrop-filter:blur(8px)}
  .ensemble-tts.et-default-dialog [role="tab"][aria-selected="true"]{background:rgb(134 171 213 / 18%);border-color:var(--abyss-accent);color:#e9f2ff}
  .choir-mixer{
    --cm-accent:var(--abyss-accent);--cm-accent-text:#e9f2ff;--cm-accent-contrast:#061323;
    --cm-bg:var(--abyss-bg);--cm-bg-elevated:var(--abyss-surface);--cm-text:var(--abyss-text);
    --cm-muted:var(--abyss-muted);--cm-dim:var(--abyss-dim);--cm-line:var(--abyss-line);
    --cm-border-hover:var(--abyss-line-hover);--cm-hover:var(--abyss-hover);--cm-fill:rgb(10 28 50 / 62%);
    --cm-accent-soft:rgb(134 171 213 / 12%);--cm-accent-line:rgb(134 171 213 / 50%);--cm-warning:#e0cfaa;
    --lumiverse-primary-hover:var(--abyss-accent-hover);--lumiverse-input-bg:rgb(4 13 27 / 76%);
    background:radial-gradient(ellipse at 100% 0%,rgb(35 83 134 / 27%),transparent 65%),linear-gradient(150deg,#0d2138,#061323 70%);
    border-color:var(--abyss-line-hover);box-shadow:0 16px 48px rgb(1 7 16 / 60%),0 0 22px rgb(134 171 213 / 8%),inset 0 1px 0 rgb(185 208 235 / 8%);
    font-family:var(--ac-ui-font,"Segoe UI",system-ui,sans-serif);
  }
  .choir-mixer .cm-header{background-image:var(--abyss-stars);background-position:30% 0}
  .choir-mixer .cm-brand strong{color:var(--abyss-gold);font-family:var(--ac-display-font,Georgia,serif);font-size:16px;letter-spacing:.03em}
  .choir-mixer .cm-brand-icon{color:var(--abyss-gold);border:1px solid var(--abyss-line);background:rgb(134 171 213 / 9%)}
  .choir-mixer .cm-channel-tabs{background:var(--abyss-bg)}
  .choir-mixer .cm-channel-tab[aria-selected="true"]{border-color:var(--abyss-accent);box-shadow:inset 0 1px 0 rgb(185 208 235 / 10%)}
  .choir-mixer .cm-channel[aria-current="true"]{border-radius:8px}
  .choir-mixer[data-collapsed="true"]{background:radial-gradient(circle at 35% 25%,#254569,#061323 75%);box-shadow:0 6px 20px rgb(1 7 16 / 55%),0 0 18px rgb(134 171 213 / 15%);color:var(--abyss-gold)}
  .choir-auto-plan-action,.choir-follow-resume{color:var(--abyss-text);background:var(--abyss-surface);border-color:var(--abyss-line-hover)}
  .choir-auto-plan-action[aria-pressed="true"]{background:rgb(134 171 213 / 20%);border-color:var(--abyss-accent);color:#e9f2ff}
  @media(max-width:600px){.ensemble-tts{padding:12px;border-radius:12px}.ensemble-tts .et-header{gap:8px}.ensemble-tts h2{font-size:1.5em}.ensemble-tts .et-constellation-name{font-size:9px;letter-spacing:.1em}}
  @media(prefers-reduced-motion:reduce){.ensemble-tts button,.ensemble-tts input,.ensemble-tts select,.ensemble-tts textarea{transition:none}}
  @media(forced-colors:active){
    .ensemble-tts,.ensemble-tts.et-default-dialog,.choir-mixer,.choir-mixer[data-collapsed="true"]{background:Canvas;color:CanvasText;border-color:CanvasText;box-shadow:none}
    .ensemble-tts .et-header,.choir-mixer .cm-header{background-image:none}
    .ensemble-tts h2,.ensemble-tts h3,.ensemble-tts label,.ensemble-tts .et-cast-header strong,.choir-mixer .cm-brand strong{color:CanvasText}
    .ensemble-tts button,.ensemble-tts .et-btn-primary,.ensemble-tts [data-et="latest"]{background:ButtonFace;color:ButtonText;border-color:ButtonText}
  }
`;
