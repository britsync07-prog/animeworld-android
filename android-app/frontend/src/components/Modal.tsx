export function esc(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function buildCombinedMaster(video: any, audios: any[]): string {
  let m = '#EXTM3U\n';
  audios.forEach((a: any) => {
    m += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${esc(a.name || a.lang)}",LANGUAGE="${esc(a.lang)}",AUTOSELECT=YES,DEFAULT=YES,URI="${esc(a.uri)}"\n`;
  });
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${video.bandwidth},AUDIO="a"` + (video.codecs ? `,CODECS="${esc(video.codecs)}"` : '') + `\n${video.uri}\n`;
  return m;
}

export function pickTracks(
  tracks: any,
  opts: any = {}
): Promise<{ lang: string; all: boolean; video: any } | null> {
  const langs = tracks.audio || [];
  const vids = tracks.video || [];
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    let defVideo = vids.reduce((b: any, v: any) =>
      (b && Math.abs(b.bandwidth - 800000) < Math.abs(v.bandwidth - 800000)) ? b : v, vids[0]);
    let defLang = (langs.find((l: any) => /eng/i.test(l.lang || l.name)) || langs[0] || {}).lang || '';

    overlay.innerHTML = `
      <div class="modal">
        <h3>${opts.audioOnly ? 'Choose audio language' : 'Download options'}</h3>
        ${langs.length ? `
          <label class="lbl">Audio${langs.length > 1 ? ' (pick one)' : ''}</label>
          <div class="opt">
            ${langs.map((l: any) => `<button class="opt-btn ${l.lang === defLang ? 'sel' : ''}" data-lang="${esc(l.lang)}">${esc(l.name || l.lang)}</button>`).join('')}
          </div>
          ${!opts.audioOnly ? `<label class="ck"><input type="checkbox" id="allAud"> Download ALL audio tracks (bigger file)</label>` : ""}
        ` : `<p class="muted">No separate audio tracks — video has embedded audio.</p>`}
        ${opts.audioOnly ? '' : `
          <label class="lbl">Quality</label>
          <div class="opt">
            ${vids.map((v: any) => `<button class="opt-btn ${v.uri === (defVideo && defVideo.uri) ? 'sel' : ''}" data-vb="${v.bandwidth}">${Math.round(v.bandwidth / 1000)} kb/s</button>`).join('')}
          </div>`}
        <div class="modal-actions">
          <button id="mCancel" class="btn ghost">Cancel</button>
          <button id="mOk" class="btn">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const langBtns = overlay.querySelectorAll('.opt-btn[data-lang]');
    langBtns.forEach((b: any) => {
      b.onclick = () => {
        langBtns.forEach((x: any) => x.classList.remove('sel'));
        b.classList.add('sel');
        defLang = b.dataset.lang;
      };
    });

    const vBtns = overlay.querySelectorAll('.opt-btn[data-vb]');
    vBtns.forEach((b: any) => {
      b.onclick = () => {
        vBtns.forEach((x: any) => x.classList.remove('sel'));
        b.classList.add('sel');
        defVideo = vids.find((v: any) => +v.bandwidth === +b.dataset.vb) || defVideo;
      };
    });

    const allChk = overlay.querySelector('#allAud');
    (overlay.querySelector('#mCancel') as HTMLElement).onclick = () => { overlay.remove(); resolve(null); };
    (overlay.querySelector('#mOk') as HTMLElement).onclick = () => {
      const all = allChk ? (allChk as HTMLInputElement).checked : false;
      overlay.remove();
      resolve({ lang: defLang, all, video: defVideo });
    };
  });
}
